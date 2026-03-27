/**
 * Structured JSON Logger
 * 
 * Emits one JSON object per line to stdout.
 * Log level controlled by LOG_LEVEL env var (default: info).
 * Each entry includes: level, timestamp, component, message, ...extra fields.
 */

const LOG_LEVELS = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5
};

const DEFAULT_LEVEL = 'info';
const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LOG_LEVELS[DEFAULT_LEVEL];

function log(level, component, message, extra = {}) {
  if (LOG_LEVELS[level] === undefined || LOG_LEVELS[level] < currentLevel) {
    return;
  }

  const entry = {
    level,
    timestamp: new Date().toISOString(),
    component,
    message,
    ...extra
  };

  console.log(JSON.stringify(entry));
}

const logger = {
  trace: (component, message, extra) => log('trace', component, message, extra),
  debug: (component, message, extra) => log('debug', component, message, extra),
  info:  (component, message, extra) => log('info',  component, message, extra),
  warn:  (component, message, extra) => log('warn',  component, message, extra),
  error: (component, message, extra) => log('error', component, message, extra),
  fatal: (component, message, extra) => log('fatal', component, message, extra)
};

module.exports = { logger };
