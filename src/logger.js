function stamp() {
  return new Date().toISOString().slice(11, 23);
}

function emit(stream, level, message, meta) {
  const suffix = meta === undefined ? '' : ` ${typeof meta === 'string' ? meta : JSON.stringify(meta)}`;
  stream.write(`${stamp()} ${level} ${message}${suffix}\n`);
}

/** Minimal console logger; nothing is written to files. */
export function createLogger({ quiet = false } = {}) {
  return {
    quiet,
    info(message, meta) {
      if (!quiet) emit(process.stdout, 'INFO ', message, meta);
    },
    warn(message, meta) {
      emit(process.stderr, 'WARN ', message, meta);
    },
    error(message, meta) {
      emit(process.stderr, 'ERROR', message, meta);
    },
  };
}
