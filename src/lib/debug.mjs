export function debug(msg, obj) {
  if (process.env.DEBUG == '1') {
    console.debug((msg ? msg + ' ' : '') + (obj ? JSON.stringify(obj, null, 2) : ''));
  }
}

export function log(msg, obj) {
  console.log((msg ? msg + ' ' : '') + (obj ? JSON.stringify(obj, null, 2) : ''));
}