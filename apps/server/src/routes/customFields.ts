import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database, CustomFieldDefinition } from '@testify/db';
import { CustomFieldRepository, TestCaseRepository, TestSuiteRepository } from '@testify/db';
import {
  CUSTOM_FIELD_TYPES,
  CUSTOM_FIELD_ENTITY_TYPES,
  MAX_NAME_LENGTH,
  resolveDefaultValue,
  type CustomFieldEntityType,
  type CustomFieldType,
} from '@testify/core';
import { authenticateRequest, requirePermission, requireAnyPermission, EXECUTION_READ_PERMISSIONS } from '../middleware/auth.js';
import { sendCustomFieldInUseError, sendProblemDetails, isPublicError, sendError } from '../errors.js';
import { requestOrigin } from '../audit.js';
import * as F from '../openapi/areas/spec.js';
import * as A from '../openapi/areas/admin.js';

function isEntityType(value: unknown): value is CustomFieldEntityType {
  return typeof value === 'string' && (CUSTOM_FIELD_ENTITY_TYPES as readonly string[]).includes(value);
}

/**
 * What a definition's text must fit (name varchar(100); label, option label and value
 * varchar(255)), as invalid_params. Too long used to fail with a 500.
 */
function definitionSizeProblems(body: { name?: unknown; field_label?: unknown; options?: unknown }): Array<{ name: string; reason: string }> {
  const out: Array<{ name: string; reason: string }> = [];
  const tooLong = (field: string, value: unknown, max: number) => {
    if (typeof value === 'string' && value.length > max) out.push({ name: field, reason: `can be at most ${max} characters` });
  };
  tooLong('name', body.name, 100);
  tooLong('field_label', body.field_label, MAX_NAME_LENGTH);
  if (Array.isArray(body.options)) {
    body.options.forEach((option: any, i: number) => {
      tooLong(`options[${i}].option_label`, option?.option_label, MAX_NAME_LENGTH);
      tooLong(`options[${i}].option_value`, option?.option_value, MAX_NAME_LENGTH);
    });
  }
  return out;
}

function sendSizeProblems(reply: FastifyReply, problems: Array<{ name: string; reason: string }>) {
  return sendError(reply, 400, problems.map((p) => `${p.name} ${p.reason}`).join('; '), { invalid_params: problems });
}

/**
 * A required field must always ship with a usable default -- on creation, so every already-
 * existing case/suite has a value for it the moment the field exists (defaults are applied to
 * entities that have no value row yet -- see CustomFieldRepository.getValuesForEntity), and
 * just as much on any later update, since removing a required field's default (or flipping an
 * already-existing field to required with none) would leave every entity that's never been
 * individually touched with an empty required value from that point on. Enforced identically
 * on both POST (create) and PUT (update) -- see both route handlers below. Returns the error
 * message to show, or null when the combination is fine.
 */
function requiredFieldDefaultError(
  isRequired: boolean,
  fieldType: CustomFieldType,
  defaultValue: string | null | undefined,
  options: Array<{ option_value: string }> | undefined
): string | null {
  if (!isRequired) return null;
  if (defaultValue === null || defaultValue === undefined || String(defaultValue).trim() === '') {
    return 'A required custom field must have a default value.';
  }
  const resolved = resolveDefaultValue(fieldType, String(defaultValue), { options });
  if (resolved === null) {
    return `The default value '${defaultValue}' is not valid for a ${fieldType} field, so existing records would still have no value. Provide a valid default value.`;
  }
  // resolveDefaultValue happily returns [] for a MULTI_SELECT default of '[]' (a syntactically
  // valid, but practically empty, JSON array) -- that's not a usable default for a required
  // field any more than a blank string is, so it needs its own check: at least one option must
  // actually be toggled on.
  if (fieldType === 'MULTI_SELECT' && Array.isArray(resolved) && resolved.length === 0) {
    return 'A required custom field must have a default value.';
  }
  return null;
}

/**
 * Global admin-defined custom fields for Test Cases and Test Suites -- a parallel,
 * independent system from routes/ingestion.ts's project-scoped, entity_type
 * 'TestCaseVersion' custom fields created during XML/CSV/JSON import reconciliation.
 * See CustomFieldRepository for why the two never collide (different entity_type values,
 * always-null vs. always-set project_id).
 */
export async function registerCustomFieldRoutes(app: FastifyInstance, db: Kysely<Database>, jwtSecret: string) {
  const fieldRepo = new CustomFieldRepository(db);
  const caseRepo = new TestCaseRepository(db);
  const suiteRepo = new TestSuiteRepository(db);

  /** The names of these projects, by id (for showing which projects a field applies to). */
  const projectNames = async (ids: string[]): Promise<Map<string, string>> =>
    new Map(ids.length > 0 ? (await db.selectFrom('projects').select(['id', 'name']).where('id', 'in', ids).execute()).map((p) => [p.id, p.name]) : []);

  /** Definitions with `projects`: the id and name of each project a project field applies to. */
  const withProjects = async <D extends CustomFieldDefinition>(definitions: D[]) => {
    const names = await projectNames([...new Set(definitions.flatMap((d) => d.project_ids))]);
    return definitions.map((d) => ({ ...d, projects: d.project_ids.map((id) => ({ id, name: names.get(id) ?? null })) }));
  };

  // ---- Definition CRUD (admin-only, gated by CUSTOM_FIELD_MANAGE) ----

  app.get(
    '/api/v1/admin/custom-fields',
    { schema: A.listDefinitionsSchema, preHandler: requirePermission('CUSTOM_FIELD_MANAGE', db, jwtSecret) },
    async (request) => {
      const { entity_type: entityType } = request.query as { entity_type?: string };
      // Every field: those for all projects, and those for chosen projects (with their names,
      // so the Admin Panel can say where each applies).
      const definitions = await fieldRepo.listAllScopes(isEntityType(entityType) ? entityType : undefined);
      return { definitions: await withProjects(definitions) };
    }
  );

  app.post(
    '/api/v1/admin/custom-fields',
    { schema: A.createDefinitionSchema, preHandler: requirePermission('CUSTOM_FIELD_MANAGE', db, jwtSecret) },
    async (request, reply) => {
      const activeUser = request.user!;
      const { entity_type: entityType, name, field_label, field_type, is_required, default_value, validation_regex, options, project_ids: projectIdsRaw } =
        (request.body as any) || {};

      if (!isEntityType(entityType)) {
        return sendError(reply, 400, `entity_type must be one of: ${CUSTOM_FIELD_ENTITY_TYPES.join(', ')}`);
      }
      if (!name || typeof name !== 'string' || !field_label || typeof field_label !== 'string') {
        return sendError(reply, 400, 'name and field_label (strings) are required');
      }
      if (!(CUSTOM_FIELD_TYPES as readonly string[]).includes(field_type)) {
        return sendError(reply, 400, `field_type must be one of: ${CUSTOM_FIELD_TYPES.join(', ')}`);
      }
      const sizeProblems = definitionSizeProblems({ name, field_label, options });
      if (sizeProblems.length > 0) return sendSizeProblems(reply, sizeProblems);
      // Optional: the projects it applies to. Left out or empty: all projects.
      if (projectIdsRaw !== undefined && (!Array.isArray(projectIdsRaw) || projectIdsRaw.some((p: unknown) => typeof p !== 'string'))) {
        return sendError(reply, 400, 'project_ids must be a list of project ids', { invalid_params: [{ name: 'project_ids', reason: 'must be a list of project ids' }] });
      }
      const projectIds: string[] = projectIdsRaw ?? [];
      if (projectIds.length > 0) {
        const known = await projectNames(projectIds);
        const unknown = projectIds.filter((p) => !known.has(p));
        if (unknown.length > 0) return sendError(reply, 400, `Unknown project: ${unknown.join(', ')}`, { invalid_params: [{ name: 'project_ids', reason: 'names a project that doesn\'t exist' }] });
      }

      const requiredError = requiredFieldDefaultError(
        Boolean(is_required),
        field_type,
        default_value,
        Array.isArray(options) ? options : undefined
      );
      if (requiredError) {
        return sendError(reply, 422, requiredError, { code: 'REQUIRED_FIELD_NEEDS_DEFAULT' });
      }

      try {
        const definition = await fieldRepo.createDefinition({
          entity_type: entityType,
          name,
          field_label,
          field_type,
          is_required: Boolean(is_required),
          default_value: default_value ?? null,
          validation_regex: validation_regex ?? null,
          options: Array.isArray(options) ? options : undefined,
          project_ids: projectIds,
        });

        // Freeze the default into a real value row for every pre-existing entity right now,
        // so a later edit to this definition's default_value can't silently rewrite what
        // already-existing records "had" at creation time -- see the method's own comment.
        const seededCount = await fieldRepo.seedDefaultValueForAllEntities(definition);

        const now = new Date().toISOString();
        await db
          .insertInto('audit_logs')
          .values({
            id: crypto.randomUUID(),
            actor_id: activeUser.id,
            actor_type: 'USER',
            action: 'CUSTOM_FIELD_DEFINITION_CREATED',
            resource_type: 'custom_field_definition',
            resource_id: definition.id,
            diff: JSON.stringify({ entity_type: entityType, name, field_label, field_type, project_ids: projectIds, seeded_count: seededCount }),
            ...requestOrigin(request),
            created_at: now,
          })
          .execute();

        return reply.status(201).send({ definition: (await withProjects([definition]))[0], seeded_count: seededCount });
      } catch (err: any) {
        if (sendInvalidPattern(reply, err)) return;
        if (err.message?.startsWith('UNKNOWN_ENTITY_TYPE') || err.message?.startsWith('UNKNOWN_FIELD_TYPE')) {
          return sendError(reply, 400, err.message);
        }
        if (err.message?.startsWith('FIELD_NAME_TAKEN')) {
          return sendError(reply, 409, err.message);
        }
        throw err; // unexpected: the global error handler logs it and answers 500
      }
    }
  );

  app.patch(
    '/api/v1/admin/custom-fields/:id',
    { schema: A.updateDefinitionSchema, preHandler: requirePermission('CUSTOM_FIELD_MANAGE', db, jwtSecret) },
    async (request, reply) => {
      const activeUser = request.user!;
      const { id } = request.params as { id: string };
      const { name, field_label, is_required, default_value, validation_regex, options } = (request.body as any) || {};
      const sizeProblems = definitionSizeProblems({ name, field_label, options });
      if (sizeProblems.length > 0) return sendSizeProblems(reply, sizeProblems);

      // Any scope: a project's own field (made by an import) is managed here too.
      const existing = await fieldRepo.getDefinitionAnyScope(id);
      if (!existing) {
        return sendError(reply, 404, 'Custom field not found');
      }
      const requiredError = requiredFieldDefaultError(
        is_required !== undefined ? Boolean(is_required) : existing.is_required,
        existing.field_type,
        default_value !== undefined ? default_value : existing.default_value,
        Array.isArray(options) ? options : existing.options
      );
      if (requiredError) {
        return sendError(reply, 422, requiredError, { code: 'REQUIRED_FIELD_NEEDS_DEFAULT' });
      }

      try {
        const definition = await fieldRepo.updateDefinition(id, {
          name: typeof name === 'string' ? name : undefined,
          field_label: typeof field_label === 'string' ? field_label : undefined,
          is_required: is_required !== undefined ? Boolean(is_required) : undefined,
          default_value: default_value !== undefined ? default_value : undefined,
          validation_regex: validation_regex !== undefined ? validation_regex : undefined,
          options: Array.isArray(options) ? options : undefined,
        });

        if (!definition) {
          return sendError(reply, 404, 'Custom field not found');
        }

        // If this update leaves the field required with a usable default (already
        // guaranteed by the requiredFieldDefaultError check above whenever is_required is
        // true), any existing value row that's explicitly blank -- e.g. cleared out while
        // the field was still optional -- is no longer a valid state to leave sitting there.
        // Switch those rows to the default too, not just entities with no row at all (which
        // already pick up the default live via getValuesForEntity's read-time fallback).
        const appliedDefaultCount = definition.is_required
          ? await fieldRepo.applyDefaultToBlankValues(definition)
          : 0;

        const now = new Date().toISOString();
        await db
          .insertInto('audit_logs')
          .values({
            id: crypto.randomUUID(),
            actor_id: activeUser.id,
            actor_type: 'USER',
            action: 'CUSTOM_FIELD_DEFINITION_UPDATED',
            resource_type: 'custom_field_definition',
            resource_id: id,
            diff: JSON.stringify({ name, field_label, is_required, default_value, validation_regex, applied_default_count: appliedDefaultCount }),
            ...requestOrigin(request),
            created_at: now,
          })
          .execute();

        return reply.status(200).send({ definition: (await withProjects([definition]))[0], applied_default_count: appliedDefaultCount });
      } catch (err: any) {
        if (sendInvalidPattern(reply, err)) return;
        if (err.message?.startsWith('FIELD_NAME_TAKEN')) {
          return sendError(reply, 409, err.message);
        }
        throw err; // unexpected: the global error handler logs it and answers 500
      }
    }
  );

  // PUT /api/v1/admin/custom-fields/:id/projects?force=true -- the projects a field applies to.
  // A project it no longer applies to loses the field's values there: without force, a 409 names
  // those projects and counts; with force, the values go. New projects get the default.
  app.put(
    '/api/v1/admin/custom-fields/:id/projects',
    { schema: A.setDefinitionProjectsSchema, preHandler: requirePermission('CUSTOM_FIELD_MANAGE', db, jwtSecret) },
    async (request, reply) => {
      const activeUser = request.user!;
      const { id } = request.params as { id: string };
      const { force } = request.query as { force?: string };
      const { all_projects: allProjects, project_ids: projectIdsRaw } = (request.body as any) || {};
      if (typeof allProjects !== 'boolean') {
        return sendError(reply, 400, 'all_projects (true or false) is required', { invalid_params: [{ name: 'all_projects', reason: 'must be true or false' }] });
      }
      if (projectIdsRaw !== undefined && (!Array.isArray(projectIdsRaw) || projectIdsRaw.some((p: unknown) => typeof p !== 'string'))) {
        return sendError(reply, 400, 'project_ids must be a list of project ids', { invalid_params: [{ name: 'project_ids', reason: 'must be a list of project ids' }] });
      }

      const before = await fieldRepo.getDefinitionAnyScope(id);
      if (!before) return sendError(reply, 404, 'Custom field not found');
      let result;
      try {
        result = await fieldRepo.setProjects(id, { all_projects: allProjects, project_ids: projectIdsRaw ?? [] }, { force: force === 'true' });
      } catch (err: any) {
        if (String(err?.message).startsWith('FIELD_NAME_TAKEN')) return sendError(reply, 409, err.message, { code: 'FIELD_NAME_TAKEN' });
        if (isPublicError(err)) return sendError(reply, 400, err.message, { invalid_params: [{ name: 'project_ids', reason: err.message }] });
        throw err;
      }
      if (!result) return sendError(reply, 404, 'Custom field not found');

      if (!result.changed) {
        const names = await projectNames(result.affected_projects.map((a) => a.project_id));
        const affected = result.affected_projects.map((a) => ({ ...a, project_name: names.get(a.project_id) ?? null }));
        const total = affected.reduce((n, a) => n + a.value_count, 0);
        const where = affected.map((a) => `${a.project_name ?? a.project_id} (${a.value_count})`).join(', ');
        return sendError(
          reply,
          409,
          `'${before.field_label}' has ${total} value${total === 1 ? '' : 's'} in ${affected.length === 1 ? 'a project' : 'projects'} it would no longer apply to: ${where}. Those values will be deleted.`,
          { code: 'CUSTOM_FIELD_PROJECTS_IN_USE', affected_projects: affected }
        );
      }

      await db
        .insertInto('audit_logs')
        .values({
          id: crypto.randomUUID(),
          actor_id: activeUser.id,
          actor_type: 'USER',
          action: 'CUSTOM_FIELD_PROJECTS_CHANGED',
          resource_type: 'custom_field_definition',
          resource_id: id,
          diff: JSON.stringify({
            from: { all_projects: before.all_projects, project_ids: before.project_ids },
            to: { all_projects: result.definition.all_projects, project_ids: result.definition.project_ids },
            removed_value_count: result.removed_value_count,
            seeded_count: result.seeded_count,
          }),
          ...requestOrigin(request),
          created_at: new Date().toISOString(),
        })
        .execute();

      return reply.status(200).send({
        definition: (await withProjects([result.definition]))[0],
        removed_value_count: result.removed_value_count,
        seeded_count: result.seeded_count,
      });
    }
  );

  // DELETE /api/v1/admin/custom-fields/:id?force=true -- warn-then-confirm delete. Without
  // `force`, a definition with recorded values is left untouched and reported via 409 with
  // the affected count; passing force=true (after the admin confirms) deletes it and all its
  // values for good. Deliberately more permissive than role.repository.ts's deleteRole,
  // which never allows deleting a role that's in use.
  app.delete(
    '/api/v1/admin/custom-fields/:id',
    { schema: A.deleteDefinitionSchema, preHandler: requirePermission('CUSTOM_FIELD_MANAGE', db, jwtSecret) },
    async (request, reply) => {
      const activeUser = request.user!;
      const { id } = request.params as { id: string };
      const { force } = request.query as { force?: string };

      const result = await fieldRepo.deleteDefinition(id, { force: force === 'true' });
      if (!result.deleted) {
        if (result.blockedByValueCount === 0) {
          return sendError(reply, 404, 'Custom field not found');
        }
        return sendCustomFieldInUseError(reply, id, result.blockedByValueCount, request.url, result.fieldLabel);
      }

      const now = new Date().toISOString();
      await db
        .insertInto('audit_logs')
        .values({
          id: crypto.randomUUID(),
          actor_id: activeUser.id,
          actor_type: 'USER',
          action: 'CUSTOM_FIELD_DEFINITION_DELETED',
          resource_type: 'custom_field_definition',
          resource_id: id,
          diff: JSON.stringify({ forced: force === 'true' }),
          ...requestOrigin(request),
          created_at: now,
        })
        .execute();

      return reply.status(204).send();
    }
  );

  // ---- Value CRUD (Spec-mode curation surface: read is open to any authenticated user,
  // mutation is gated by PLAN_MANAGE, matching every other Spec-mode curation route in
  // testPlanCases.ts) ----

  app.get('/api/v1/cases/:caseId/custom-fields', { schema: F.caseFieldSchemas.list, preHandler: requireAnyPermission(EXECUTION_READ_PERMISSIONS, db, jwtSecret) }, async (request, reply) => {

    const { caseId } = request.params as { caseId: string };
    const testCase = await caseRepo.findById(caseId);
    if (!testCase) {
      return sendError(reply, 404, 'Test case not found');
    }

    const values = await fieldRepo.getValuesForEntity('TestCase', caseId, testCase.project_id);
    return { values };
  });

  app.put(
    '/api/v1/cases/:caseId/custom-fields/:definitionId',
    { schema: F.caseFieldSchemas.set, preHandler: requirePermission('PLAN_MANAGE', db, jwtSecret) },
    async (request, reply) => {
      const { caseId, definitionId } = request.params as { caseId: string; definitionId: string };
      const { value } = (request.body as { value?: unknown }) || {};

      const testCase = await caseRepo.findById(caseId);
      if (!testCase) {
        return sendError(reply, 404, 'Test case not found');
      }

      try {
        const savedValue = await fieldRepo.setValue(definitionId, 'TestCase', caseId, value, testCase.project_id);
        return reply.status(200).send({ value: savedValue });
      } catch (err: any) {
        if (err.message?.startsWith('UNKNOWN_FIELD')) {
          return sendError(reply, 404, err.message);
        }
        if (!isPublicError(err)) throw err;
        return sendProblemDetails(reply, {
          code: err.message?.split(':')[0] || 'INVALID_FIELD_VALUE',
          detail: err.message || 'Invalid custom field value',
          instance: request.url,
        });
      }
    }
  );

  app.delete(
    '/api/v1/cases/:caseId/custom-fields/:definitionId',
    { schema: F.caseFieldSchemas.clear, preHandler: requirePermission('PLAN_MANAGE', db, jwtSecret) },
    async (request, reply) => {
      const { caseId, definitionId } = request.params as { caseId: string; definitionId: string };
      const testCase = await caseRepo.findById(caseId);
      if (!testCase) {
        return sendError(reply, 404, 'Test case not found');
      }
      await fieldRepo.deleteValue(definitionId, 'TestCase', caseId);
      return reply.status(204).send();
    }
  );

  app.get('/api/v1/suites/:suiteId/custom-fields', { schema: F.suiteFieldSchemas.list, preHandler: requirePermission('SPEC_VIEW', db, jwtSecret) }, async (request, reply) => {

    const { suiteId } = request.params as { suiteId: string };
    const suite = await suiteRepo.findById(suiteId);
    if (!suite) {
      return sendError(reply, 404, 'Test suite not found');
    }

    const values = await fieldRepo.getValuesForEntity('TestSuite', suiteId, suite.project_id);
    return { values };
  });

  app.put(
    '/api/v1/suites/:suiteId/custom-fields/:definitionId',
    { schema: F.suiteFieldSchemas.set, preHandler: requirePermission('PLAN_MANAGE', db, jwtSecret) },
    async (request, reply) => {
      const { suiteId, definitionId } = request.params as { suiteId: string; definitionId: string };
      const { value } = (request.body as { value?: unknown }) || {};

      const suite = await suiteRepo.findById(suiteId);
      if (!suite) {
        return sendError(reply, 404, 'Test suite not found');
      }

      try {
        const savedValue = await fieldRepo.setValue(definitionId, 'TestSuite', suiteId, value, suite.project_id);
        return reply.status(200).send({ value: savedValue });
      } catch (err: any) {
        if (err.message?.startsWith('UNKNOWN_FIELD')) {
          return sendError(reply, 404, err.message);
        }
        if (!isPublicError(err)) throw err;
        return sendProblemDetails(reply, {
          code: err.message?.split(':')[0] || 'INVALID_FIELD_VALUE',
          detail: err.message || 'Invalid custom field value',
          instance: request.url,
        });
      }
    }
  );

  app.delete(
    '/api/v1/suites/:suiteId/custom-fields/:definitionId',
    { schema: F.suiteFieldSchemas.clear, preHandler: requirePermission('PLAN_MANAGE', db, jwtSecret) },
    async (request, reply) => {
      const { suiteId, definitionId } = request.params as { suiteId: string; definitionId: string };
      const suite = await suiteRepo.findById(suiteId);
      if (!suite) {
        return sendError(reply, 404, 'Test suite not found');
      }
      await fieldRepo.deleteValue(definitionId, 'TestSuite', suiteId);
      return reply.status(204).send();
    }
  );
}

/** A validation pattern that doesn't compile or is too long (CustomFieldRepository). */
function sendInvalidPattern(reply: FastifyReply, err: any): boolean {
  const prefix = 'INVALID_VALIDATION_PATTERN: ';
  if (typeof err?.message !== 'string' || !err.message.startsWith(prefix)) return false;
  sendError(reply, 400, err.message.slice(prefix.length), { code: 'INVALID_VALIDATION_PATTERN' });
  return true;
}
