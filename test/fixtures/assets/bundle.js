// npmap test fixture bundle.
// Contains one known signature and a reference to a lazily-loaded chunk.
(function () {
  "use strict";
  window.__FAKELIB_SIGNATURE__ = { init: true };
  var chunkMap = { main: "chunk.abc123.js" };
  function loadChunk(name) {
    return import("/assets/" + chunkMap[name]);
  }
  window.__loadFakeChunk = loadChunk;
})();
