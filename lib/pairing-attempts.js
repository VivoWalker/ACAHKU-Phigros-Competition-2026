// A failed device must not remain in memory after its one-minute lockout window.
// Keep the number of tracked devices bounded without evicting active lockouts.
class PairingAttempts {
  constructor({ windowMs = 60000, maxAttempts = 10, maxEntries = 2048, now = Date.now, cleanupMs = 30000 } = {}) {
    this.windowMs = windowMs; this.maxAttempts = maxAttempts; this.maxEntries = maxEntries; this.now = now;
    this.entries = new Map();
    this.timer = setInterval(() => this.prune(), cleanupMs);
    this.timer.unref();
  }
  prune(now = this.now()) {
    for (const [key, failures] of this.entries) {
      const current = failures.filter(at => now - at < this.windowMs);
      if (current.length) this.entries.set(key, current);
      else this.entries.delete(key);
    }
  }
  blocked(key) {
    const now = this.now(), failures = this.entries.get(key);
    if (failures) {
      const current = failures.filter(at => now - at < this.windowMs);
      if (current.length) this.entries.set(key, current);
      else this.entries.delete(key);
      return current.length >= this.maxAttempts;
    }
    if (this.entries.size >= this.maxEntries) this.prune(now);
    // Never evict an existing device to make room, which would reset its limit.
    return this.entries.size >= this.maxEntries;
  }
  fail(key) {
    if (this.blocked(key)) return;
    const failures = this.entries.get(key) || [];
    failures.push(this.now()); this.entries.set(key, failures);
  }
  clear(key) { this.entries.delete(key); }
  close() { clearInterval(this.timer); this.timer = null; this.entries.clear(); }
}

module.exports = { PairingAttempts };
