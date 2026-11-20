// Website themes: the template language, its safety rules, theme settings, design tokens and
// the five built-in themes (./themes). See docs/site-themes.md.
export { parseTemplate } from './parse';
export type { Node, Parsed, Problem } from './parse';
export { renderNodes, renderPage, RenderLimit, LIMITS } from './render';
export type {
  FormContext,
  RenderHooks,
  RenderFiles,
  SectionToRender,
  TemplateImage,
} from './render';
export {
  FONTS,
  fontMediaIds,
  isMediaId,
  mediaIds,
  resolveSettings,
  settingDefsProblems,
  settingsProblems,
  valueProblem,
  withImages,
} from './settings';
export type { FontId, SectionSchema, SettingDef, SettingType } from './settings';
export { compileTheme, THEME_LIMITS } from './theme';
export type {
  Audience,
  CompiledTheme,
  Device,
  SectionExperiment,
  SectionInstance,
  ThemeFiles,
  Variant,
} from './theme';
export {
  checkDesign,
  compileDesign,
  designCss,
  designMediaIds,
  isTesting,
  MAX_RUNNING_TESTS,
  renderDesign,
  runningTests,
  sectionsOf,
} from './design';
export { normalCdf, roundUpViews, testResult, withRate } from './stats';
export type { TestResult } from './stats';
export { designFromLegacy } from './legacy';
export type { Design } from './design';
export {
  FONT_STACKS,
  contrast,
  contrastWarnings,
  schemePages,
  standardSettings,
  tokensCss,
  uploadedFontFamily,
} from './tokens';
export type { FontLookup } from './tokens';
export { escapeAttribute, escapeText, safeUrl, urlProblem } from './html';
export { REFERENCE } from './reference';
