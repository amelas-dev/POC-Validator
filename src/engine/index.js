// Public engine API.
// analyze() = extractFacts() + resolve(); the UI caches extractFacts per corpus and
// re-runs the cheap resolve() on each what-if toggle instead of re-scanning.
export { analyze, extractFacts, resolve } from './classify.js';
export { scanCorpus } from './scan.js';
export { SIGNALS } from './ruleset.js';
export {
  parseGitHubUrl, loadFromGitHub, loadFromFileList, loadFromZip, loadFromPaste,
} from './sources.js';
