window.createBroadcastSocket = function (namespace, auth) {
  return io(namespace, { auth: auth || {}, reconnection: true, reconnectionDelay: 500, reconnectionDelayMax: 4000, timeout: 8000 });
};
