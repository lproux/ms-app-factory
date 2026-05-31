/**
 * Centralized mocks for the App Factory integration test suite.
 *
 * Each helper here returns a value (a fake handle, a canned `execa` result,
 * a fake judge, a credential stand-in) that a `vi.mock()` factory in a test
 * can return verbatim. We keep the actual `vi.mock()` calls inline at the top
 * of each test file because vitest hoists those — they must literally appear
 * in the file under test.
 */
export * from './execa.js';
export * from './orchestrator.js';
export * from './credential.js';
export * from './graph.js';
export * from './arm.js';
export * from './judges.js';
export * from './http.js';
export * from './call-recorder.js';
