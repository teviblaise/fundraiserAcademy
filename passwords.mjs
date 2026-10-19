import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

export const nativeScrypt = promisify(scryptCallback);
const strongOptions = Object.freeze({ N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
const legacyOptions = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const prefix = 'scrypt$32768$8$3$';
const dummySalt = '00000000000000000000000000000000';
const dummyHash = Buffer.alloc(64);
const concurrency = 2;
const queueLimit = 16;

function busy() {
  return Object.assign(new Error('Password processing is busy. Please try again shortly.'), { status: 503, code: 'PASSWORD_PROCESSING_BUSY' });
}

// Parameters are deliberately whitelisted rather than interpreted from a stored
// string. Corrupt or unexpected credentials cannot request an expensive KDF.
function parse(encoded) {
  if (typeof encoded !== 'string') return null;
  const legacy = /^([a-f0-9]{32}):([a-f0-9]{128})$/.exec(encoded);
  if (legacy) return { kind: 'legacy', salt: legacy[1], hash: Buffer.from(legacy[2], 'hex') };
  const strong = /^scrypt\$32768\$8\$3\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(encoded);
  return strong ? { kind: 'strong', salt: strong[1], hash: Buffer.from(strong[2], 'hex') } : null;
}

export function createPasswordManager({ scrypt = nativeScrypt } = {}) {
  const waiting = [];
  let running = 0;
  let closing = false;
  let closePromise;
  let closed;

  function drain() {
    while (running < concurrency && waiting.length) {
      const job = waiting.shift();
      running++;
      const finished = () => {
        running--;
        drain();
        if (!running && !waiting.length) closed?.();
      };
      Promise.resolve().then(job.work).then(value => { job.resolve(value); finished(); }, error => { job.reject(error); finished(); });
    }
  }
  function schedule(work) {
    if (closing || running >= concurrency && waiting.length >= queueLimit) return Promise.reject(busy());
    return new Promise((resolve, reject) => { waiting.push({ work, resolve, reject }); drain(); });
  }
  const derive = (password, salt, options) => scrypt(password, salt, 64, { ...options });

  function encode(password) {
    return schedule(async () => {
      const salt = randomBytes(16).toString('hex');
      const value = await derive(password, salt, strongOptions);
      return `${prefix}${salt}$${value.toString('hex')}`;
    });
  }
  function encodeLegacy(password) {
    return schedule(async () => {
      const salt = randomBytes(16).toString('hex');
      const value = await derive(password, salt, legacyOptions);
      return `${salt}:${value.toString('hex')}`;
    });
  }
  function verify(password, encoded) {
    return schedule(async () => {
      const credential = parse(encoded);
      const salt = credential?.salt ?? dummySalt;
      // Every login, including unknown emails and old accounts, performs both
      // approved workloads. A new hash format does not reveal account existence
      // through a trivially different amount of password hashing work.
      const legacy = await derive(password, salt, legacyOptions);
      const strong = await derive(password, salt, strongOptions);
      const legacyMatch = timingSafeEqual(legacy, credential?.kind === 'legacy' ? credential.hash : dummyHash);
      const strongMatch = timingSafeEqual(strong, credential?.kind === 'strong' ? credential.hash : dummyHash);
      return Boolean(credential && (credential.kind === 'legacy' ? legacyMatch : strongMatch));
    });
  }
  function close() {
    if (!closePromise) {
      closing = true;
      closePromise = running || waiting.length ? new Promise(resolve => { closed = resolve; }) : Promise.resolve();
    }
    return closePromise;
  }
  return { encode, encodeLegacy, verify, close };
}
