const fs = require('fs');
const http = require('http');
const log = require('@vladmandic/pilogger');
const ACME = require('@root/acme');
const Keypairs = require('@root/keypairs');
const CSR = require('@root/csr');
const PEM = require('@root/pem');
const challenge = require('acme-http-01-webroot');
const cert2json = require('cert2json');

// default user & domain configuration
let config = {
  day: 0,
  account: {},
  key: '',
  SSL: {},
  accountKey: '',
  application: 'example/0.0.1',
  domains: ['example.com'],
  maintainer: 'maintainer@example.com',
  subscriber: 'subscriber@example.com',
  accountFile: './cert/account.json',
  accountKeyFile: './cert/account.pem',
  ServerKeyFile: './cert//private.pem',
  fullChain: './cert/fullchain.pem',
  monitorInterval: 60 * 12,
  renewDays: 10,
  debug: false,
};

// internal variables
let acme;
let initial = true;
let callback = null;
const auth = [];

function notify(evt, msg) {
  if (config.debug) log.data('ACME Notification:', evt, msg);
  let key;
  if (msg.challenge && msg.challenge.keyAuthorization) key = msg.challenge.keyAuthorization;
  let token;
  if (msg.challenge && msg.challenge.token) token = msg.challenge.token;
  const host = msg.altname || '';
  if (key && token) auth.push({ token, key, host });
}

function sleep(timer = 100) {
  return new Promise((resolve) => {
    setTimeout(() => resolve(true), timer);
  });
}

async function createCert(force = false) {
  initial = true;
  // Generate or load fullchain
  let cert;
  if (force || !fs.existsSync(config.fullChain)) {
    if (!config.domains || (config.domains.length <= 0)) {
      log.info('ACME Skip create certificate', { domains: config.domains });
      return false;
    }
    log.info('ACME Create certificate', { domains: config.domains, encoding: 'der' });
    // what are we requesting
    const csrDer = await CSR.csr({ jwk: config.key, domains: config.domains, encoding: 'der' });
    // @ts-ignore
    const csr = PEM.packBlock({ type: 'CERTIFICATE REQUEST', bytes: csrDer });

    // prepare challenge verification object
    const http01 = challenge.create({ webroot: './.well-known/acme-challenge' });
    const challenges = { 'http-01': http01 };

    // start http server to listen for verification callback
    const server = http.createServer(async (req, res) => {
      // eslint-disable-next-line no-await-in-loop
      while (auth.length < config.domains.length) await sleep(100); // wait until key gets populated in notification
      const key = auth.find((a) => req?.url?.includes(a.token));
      if (key) {
        res.writeHead(200);
        res.write(key.key);
        res.end();
        log.info('ACME Challenge', { key: key.host, url: req.url, sent: key.key });
      } else {
        log.info('ACME Challenge', { key: key.host, url: req.url });
      }
    });

    // to enable node to bind to port 80 as non-root run:
    // sudo setcap 'cap_net_bind_service=+ep' `which node`
    server.listen(80, () => log.state('ACME Validation server ready'));

    // stop http server
    server.on('request', (req, res) => {
      // eslint-disable-next-line no-underscore-dangle
      req.socket._isIdle = false;
      res.on('finish', () => {
        log.state('ACME Validation', { server: 'finish' });
        req.socket['_isIdle'] = true;
        req.socket.destroy();
      });
    });
    // server.on('close', () => log.info('ACME Validation server closed'));

    // start actual verification
    log.info('ACME Validating domains:', { domains: config.domains });
    log.info(`ACME Account contract: ${config.account.contact} crv: ${config.accountKey.crv}`);

    let pems;
    try {
      pems = await acme.certificates.create({ account: config.account, accountKey: config.accountKey, csr, domains: config.domains, challenges, skipChallengeTests: true, skipDryRun: true });
    } catch (err) {
      log.warn('ACME Validation exception', err.code ? { code: err.code, syscall: err.syscall, address: err.address, port: err.port } : err);
    }

    server.close(() => log.info('ACME Validation', { server: 'close' }));

    // generate actual fullchain from received pems
    if (!pems || !pems.cert || !pems.chain) {
      log.warn('ACME Validation failed');
      return false;
    }
    log.info('ACME Certificate:', { create: config.fullChain });
    cert = `${pems.cert}\n${pems.chain}\n`;
    await fs.promises.writeFile(config.fullChain, cert, 'ascii');
  } else if (initial) {
    log.info('ACME Certificate', { load: config.fullChain });
    cert = await fs.promises.readFile(config.fullChain, 'ascii');
  }
  return true;
}

async function createKeys() {
  initial = true;
  if (!config.domains || (config.domains.length <= 0)) {
    log.info('ACME Skip create keys', { domains: config.domains });
    return;
  }
  // initialize acme
  const packageAgent = config.application;
  acme = ACME.create({ maintainerEmail: config.maintainer, packageAgent, notify });
  const directoryUrl = 'https://acme-v02.api.letsencrypt.org/directory';
  await acme.init(directoryUrl);
  log.info('ACME Request', { domains: config.domains });

  // Generate or load account key
  if (!fs.existsSync(config.accountKeyFile)) {
    log.info('ACME Account key', { generate: config.accountKeyFile });
    const accountKeypair = await Keypairs.generate({ kty: 'EC', format: 'jwk' });
    config.accountKey = accountKeypair.private;
    const pem = await Keypairs.export({ jwk: config.accountKey });
    await fs.promises.writeFile(config.accountKeyFile, pem, 'ascii');
  } else {
    log.info('ACME Account key', { load: config.accountKeyFile });
    const pem = await fs.promises.readFile(config.accountKeyFile, 'ascii');
    config.accountKey = await Keypairs.import({ pem });
  }

  // Create or load account
  if (!fs.existsSync(config.accountFile)) {
    log.info('ACME Account', { create: config.accountFile });
    config.account = await acme.accounts.create({ subscriberEmail: config.subscriber, agreeToTerms: true, accountKey: config.accountKey });
    await fs.promises.writeFile(config.accountFile, JSON.stringify(config.account), 'ascii');
  } else {
    log.info('ACME Account', { load: config.accountFile });
    const json = await fs.promises.readFile(config.accountFile, 'ascii');
    config.account = JSON.parse(json);
  }

  // Generate or load server key
  if (!fs.existsSync(config.ServerKeyFile)) {
    log.info('ACME Server key: generate', config.ServerKeyFile);
    const serverKeypair = await Keypairs.generate({ kty: 'RSA', format: 'jwk' });
    config.key = serverKeypair.private;
    const pem = await Keypairs.export({ jwk: config.key });
    await fs.promises.writeFile(config.ServerKeyFile, pem, 'ascii');
  } else {
    log.info('ACME Server key: load', config.ServerKeyFile);
    const pem = await fs.promises.readFile(config.ServerKeyFile, 'ascii');
    config.key = await Keypairs.import({ pem });
  }
}

async function parseCert() {
  const details = {};
  try {
    const f = await fs.promises.readFile(config.ServerKeyFile, 'ascii');
    const parsed = await Keypairs.parse({ key: f });
    details.serverKey = { type: parsed.public.kty, use: parsed.public.use };
  } catch (err) {
    details.serverKey = { error: err };
  }
  try {
    const f = await fs.promises.readFile(config.accountKeyFile, 'ascii');
    const parsed = await Keypairs.parse({ key: f });
    details.accountKey = { type: parsed.public.kty, crv: parsed.public.crv };
  } catch (err) {
    details.accountKey = { error: err };
  }
  try {
    const f = await fs.promises.readFile(config.fullChain, 'ascii');
    const parsed = cert2json.parse(f);
    details.fullChain = {
      subject: parsed?.tbs?.subject?.CN,
      issuer: parsed?.tbs?.issuer?.full,
      algorithm: parsed?.tbs?.signatureAlgorithm?.algo,
      notBefore: new Date(parsed.tbs.validity.notBefore),
      notAfter: new Date(parsed.tbs.validity.notAfter),
    };
  } catch (err) {
    details.fullChain = { error: err };
  }
  try {
    const f = await fs.promises.readFile(config.accountFile, 'ascii');
    const json = JSON.parse(f);
    details.account = {
      contact: json.contact[0], initialIP: json.initialIp, createdAt: new Date(json.createdAt), status: json.status,
    };
  } catch (err) {
    details.account = { error: err };
  }
  return details;
}

async function checkCert() {
  if (fs.existsSync(config.fullChain)) {
    if (initial) log.info('ACME Certificate check:', config.fullChain);
    const ssl = await parseCert();
    const now = new Date();
    if (!ssl.account || ssl.account.error) {
      log.warn(`ACME Certificate account error: ${ssl.account.error || 'unknown'}`);
      return false;
    }
    if (!ssl.serverKey || ssl.serverKey.error || !ssl.accountKey || ssl.accountKey.error) {
      log.warn(`SSL Keys error server:${ssl.serverKey.error} account:${ssl.account.error}`);
      return false;
    }
    if (!ssl.fullChain || ssl.fullChain.error) {
      log.warn(`SSL Certificate error: ${ssl.fullChain.error}`);
      return false;
    }
    // @ts-ignore
    if (!ssl.fullChain.notBefore || (now - ssl.fullChain.notBefore < 0)) {
      log.warn(`ACME Certificate invalid notBefore: ${ssl.fullChain.notBefore}`);
      return false;
    }
    // @ts-ignore
    if (!ssl.fullChain.notAfter || (now - ssl.fullChain.notAfter > 0)) {
      log.warn(`ACME Certificate invalid notAfter: ${ssl.fullChain.notAfter}`);
      return false;
    }
    // @ts-ignore
    config.remainingDays = (ssl.fullChain.notAfter - now) / 1000 / 60 / 60 / 24;
    log.state('SSL Certificate expires in', config.remainingDays.toFixed(1), `days: ${config.remainingDays < config.renewDays ? 'renewing now' : 'skipping renewal'}`);
    if (config.remainingDays < config.renewDays) return false;
    return true;
  }
  log.warn(`SSL Certificate does not exist: ${config.fullChain}`);
  return false;
}

async function getCert() {
  let certOk = false;
  certOk = await checkCert(); // check existing cert for validity and expiration
  if (!certOk) {
    await createKeys(); // used to initialize account; typically genrates only once per server lifetime otherwise load existing
    const createdOK = await createCert(true); // used to initialize certificate; typically genrates if cert doesn't exist or is about to expire
    if (!createdOK) return;
    certOk = await checkCert(); // check again
    if (!certOk) {
      log.error('SSL Certificate did not pass validation');
    }
    if (callback) {
      callback();
      callback = null;
    }
  }
}

async function monitorCert(f = null) {
  setTimeout(async () => {
    callback = f;
    await getCert();
    log.state('SSL Monitor certificate check complete');
  }, 1000 * 60 * config.monitorInterval);
}

function setConfig(userConfig) {
  config = { ...config, ...userConfig };
}

async function scanHost(host, startPort, endPort) {
  try {
    log.info('Connection test', { fetch: 'create' });
    const res = await fetch('https://www.ipfingerprints.com/scripts/getPortsInfo.php', {
      headers: {
        accept: 'application/json, text/javascript, */*; q=0.01',
        'cache-control': 'no-cache',
        'content-type': 'application/x-www-form-urlencoded',
        pragma: 'no-cache',
        Referer: 'https://www.ipfingerprints.com/portscan.php',
      },
      body: `remoteHost=${host}&start_port=${startPort}&end_port=${endPort}&normalScan=Yes&scan_type=connect&ping_type=none`,
      method: 'POST',
    });
    if (!res?.ok) return [];
    const html = await res.text();
    const text = html.replace(/<[^>]*>/g, '');
    const lines = text.split('\\n').map((line) => line.replace('\'', '').trim()).filter((line) => line.includes('tcp '));
    const parsed = lines.map((line) => line.replace('\\/tcp', '').split(' ').filter((str) => str.length > 0));
    const services = parsed.map((line) => ({ host, port: Number(line[0]), state: line[1], service: line[2] }));
    return services;
  } catch {
    return [];
  }
}

async function testConnection(host, timeout = 5000) {
  return new Promise((resolve) => {
    let timeoutCallback;
    const server = http.createServer();
    server.on('listening', () => {
      // log.state('Connection test', { server: 'listen' });
      scanHost(host, 80, 80).then((services) => {
        log.state('Connection test', { services });
        if (timeoutCallback) clearTimeout(timeoutCallback);
        resolve(services.length > 0);
        server.close();
      });
    });
    server.on('error', (err) => log.warn('Connection test', { code: err.code, call: err.syscall, port: err.port }));
    // server.on('close', () => log.info('Connection test', { server: 'close' }));
    server.on('request', (req, res) => {
      // log.state('Connection test', { url: req.url });
      res.writeHead(200);
      res.write('{ "connection": true }');
      res.end();
    });
    timeoutCallback = setTimeout(() => {
      if (server) server.close();
      log.warn('Connection test', { host, timeout });
      resolve(false);
    }, timeout);
    server.listen(80);
  });
}

async function testModule() {
  const status = await testConnection(config.domains[0]);
  log.data('Test connection', status);
  await getCert();
  const details = await parseCert(); // parse any cert
  log.data('Parsed details:', details);
}

try {
  if (require.main === module) testModule();
} catch (err) {
  log.error('test:', err);
}

exports.setConfig = setConfig;
exports.getCert = getCert;
exports.parseCert = parseCert;
exports.checkCert = checkCert;
exports.createKeys = createKeys;
exports.createCert = createCert;
exports.monitorCert = monitorCert;
exports.testConnection = testConnection;
