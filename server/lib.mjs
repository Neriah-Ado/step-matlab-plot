/**
 * step-matlab-plot  barrel：集中导出，便于 index.mjs 与单测引用。
 */
export { PLOT_TYPES, buildPlotScript, validateSpec } from './codegen.mjs';
export {
  INSTALL_GUIDANCE, resolveMatlabBin, runScript, execScript, parseResultLine, parseAllResultLines,
  readSidecar, cleanupSidecars, classifyMatlabError, matlabEnv,
} from './exec.mjs';
export {
  ensureDir, scriptDir, scriptPathFor, listFigures, readFigure, mimeFor,
} from './figures.mjs';
export {
  execInSession, stopSession, sessionStatus, resetSessions,
} from './session.mjs';
export {
  FILE_NAME_RE, PLOT_FORMATS, MAX_SERIES_POINTS, MAX_CODE_CHARS,
  assertFigureName, assertFormat, matlabStr, toNumVector, toNumMatrix,
  toStrVector, resolveDataFile, resolveOutDir, isConfirmed,
} from './validate.mjs';
