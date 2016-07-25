'use strict';
const crypto = require('crypto'),
  DEFAULT_ALG = 'sha256',
  DEFAULT_PREFIX = 'D',
  DEFAULT_TIMEOUT = 60000;  // token expires in 1min
/**
 * The security functionality will sign and verify
 * authorization tokens for a better communication
 * between service nodes.
 */
module.exports.TOKEN = null;  // this is set in index.js

/**
 * Currently, when we "sign" the signature, we only
 * sha2 the actionName + ts + {service.name?optional} + {service.type?optional}
 * */
module.exports.sign = function SignPayload(payload, service) {
  if (typeof module.exports.TOKEN !== 'string') return false;
  let expireAt = Date.now() + DEFAULT_TIMEOUT,
    hashString = payload.type + expireAt.toString();
  let publicData = {
    e: expireAt
  };
  if (service.name) {
    publicData.n = service.name;
    hashString += publicData.n;
  }
  if (service.type) {
    publicData.t = service.type;
    hashString += publicData.t;
  }
  publicData = JSON.stringify(publicData);
  let hashValue = crypto.createHmac(DEFAULT_ALG, module.exports.TOKEN)
    .update(hashString)
    .digest('hex');

  let publicStr = new Buffer(publicData, 'ascii').toString('hex');
  return DEFAULT_PREFIX + hashValue + '$' + publicStr;
}

module.exports.verify = function VerifyPayload(token, actionName) {
  if (typeof module.exports.TOKEN !== 'string') return false;
  if (token.substr(0, DEFAULT_PREFIX.length) !== DEFAULT_PREFIX) return false;
  let publicData = token.split('$')[1],
    now = Date.now(),
    expireAt;
  if (typeof publicData !== 'string' || !publicData) return false;
  try {
    let tmp = new Buffer(publicData, 'hex').toString('ascii');
    publicData = JSON.parse(tmp);
    expireAt = publicData.e;
    if (typeof expireAt !== 'number') throw 1;
    if (now >= expireAt) throw 1;  // expired.
  } catch (e) {
    return false;
  }
  // re-construct the hash and verify it.
  token = token.substr(DEFAULT_PREFIX.length).split('$')[0];
  let hashString = actionName + expireAt.toString();
  if (publicData.n) hashString += publicData.n;
  if (publicData.t) hashString += publicData.t;
  let hashValue = crypto.createHmac(DEFAULT_ALG, module.exports.TOKEN)
    .update(hashString)
    .digest('hex');
  let wrong = 0,
    max = Math.max(token.length, hashValue.length);
  for (let i = 0; i < max; i++) {
    if (token[i] !== hashValue[i]) wrong++;
  }
  if (wrong !== 0) return false;
  return publicData;
};
