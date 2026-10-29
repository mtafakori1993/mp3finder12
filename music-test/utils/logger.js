const SENSITIVE_KEY_PATTERN = /key|token|secret|authorization/i;

function safeArg(arg) {
  if (arg && typeof arg === "object") {
    try {
      return JSON.stringify(arg, (key, value) => {
        if (SENSITIVE_KEY_PATTERN.test(key)) return "[REDACTED]";
        return value;
      });
    } catch {
      return "[unserializable]";
    }
  }
  return arg;
}

function line(tag, ...args) {
  const stamp = new Date().toISOString();
  console.log(`[${stamp}] [${tag}]`, ...args.map(safeArg));
}

export const logger = {
  search: (...args) => line("SEARCH", ...args),
  openrouter: (...args) => line("OPENROUTER", ...args),
  resolver: (...args) => line("RESOLVER", ...args),
  extractor: (...args) => line("EXTRACTOR", ...args),
  validator: (...args) => line("VALIDATOR", ...args),
  ranking: (...args) => line("RANKING", ...args),
  error: (tag, ...args) => line(tag, "ERROR:", ...args)
};

export default logger;
