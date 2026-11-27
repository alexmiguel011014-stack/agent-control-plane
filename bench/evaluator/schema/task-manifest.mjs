import Ajv2020 from 'ajv/dist/2020.js';
import { readFile } from 'node:fs/promises';

const schemaUrl = new URL('../../schema/task.schema.json', import.meta.url);
const schema = JSON.parse(await readFile(schemaUrl, 'utf8'));
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

export class TaskManifestValidationError extends Error {
  constructor() {
    super('Task manifest does not match the benchmark schema');
    this.name = 'TaskManifestValidationError';
  }
}

export function validateTaskManifest(task) {
  if (!validate(task)) throw new TaskManifestValidationError();
  return task;
}
