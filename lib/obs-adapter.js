const { EventEmitter } = require('node:events');
// Optional integration point. No OBS connection or scene switching is claimed.
// An OBS WebSocket adapter can subscribe to sceneChanged and emit its own status.
module.exports = new EventEmitter();
