function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(target, patch) {
  if (!isObject(target) || !isObject(patch)) return patch;
  const out = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (isObject(value) && isObject(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

module.exports = { deepMerge };
