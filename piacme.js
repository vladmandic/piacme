const log = require('pilogger');
const fs = require('fs');
const http = require('http');
const moment = require('moment');
const ACME = require('@root/acme');
const Keypairs = require('@root/keypairs');
const CSR = require('@root/csr');
const PEM = require('@root/pem');
const challenge = require('acme-http-01-webroot');
const x509 = require('x509.js');

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
};

// internal variables
let keyAuthorization;
let acme;
let initial = true;

function notify(evt, msg) {
  log.data('ACME notification:', evt, msg);
  if (msg.keyAuthorization) keyAuthorization = keyAuthorization || msg.keyAuthorization;
  if (msg.challenge && msg.challenge.keyAuthorization) keyAuthorization = keyAuthorization || msg.challenge.keyAuthorization;
}

function sleep(timer = 100) {
  return new Promise((resolve) => { setTimeout(() => resolve(), timer); });
}

async function createCert(force = false) {
  initial = true;
  // Generate or load fullchain
  let cert;
  if (force || !fs.existsSync(config.fullChain)) {
    log.info('ACME create certificate');
    // what are we requesting
    const csrDer = await CSR.csr({ jwk: config.key, domains: config.domains, encoding: 'der' });
    const csr = PEM.packBlock({ type: 'CERTIFICATE REQUEST', bytes: csrDer });

    // prepare challenge verification object
    const http01 = challenge.create({ webroot: './.well-known/acme-challenge' });
    const challenges = { 'http-01': http01 };

    // start http server to listen for verification callback
    const server = http.createServer(async (req, res) => {
      while (!keyAuthorization) await sleep(100); // wait until key gets populated in notification
      if (req.url.includes('/.well-known/acme-challenge/')) {
        res.writeHead(200);
        res.write(keyAuthorization);
        res.end();
        log.info(`HTTP request:${req.url} sent:${keyAuthorization}`);
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    // to enable node to bind to port 80 as non-root run:
    // sudo setcap 'cap_net_bind_service=+ep' `which node`
    server.listen(80, () => log.state('ACME validation server ready'));

    // start actual verification
    log.info(`ACME validating domains: ${config.domains.join(' ')}`);
    const pems = await acme.certificates.create({ account: config.account, accountKey: config.accountKey, csr, domains: config.domains, challenges, skipChallengeTests: true, skipDryRun: true });

    // stop http server
    server.on('request', (req, res) => {
      // eslint-disable-next-line no-underscore-dangle
      req.socket._isIdle = false;
      res.on('finish', () => {
        log.state('ACME validation server closing');
        // eslint-disable-next-line no-underscore-dangle
        req.socket._isIdle = true;
        req.socket.destroy();
      });
    });
    server.close(() => log.info('ACME validation server closed'));

    // generate actual fullchain from received pems
    if (!pems || !pems.cert || !pems.chain) {
      log.info('ACME validation: failed');
    } else {
      log.info('ACME certificate: create:', config.fullChain);
      cert = `${pems.cert}\n${pems.chain}\n`;
      await fs.promises.writeFile(config.fullChain, cert, 'ascii');
    }
  } else if (initial) {
    log.info('ACME certificate: load:', config.fullChain);
    cert = await fs.promises.readFile(config.fullChain, 'ascii');
  }
}

async function createKeys() {
  initial = true;
  log.info('ACME create server keys');
  // initialize acme
  const packageAgent = config.application;
  acme = ACME.create({ maintainerEmail: config.maintainer, packageAgent, notify });
  const directoryUrl = 'https://acme-v02.api.letsencrypt.org/directory';
  await acme.init(directoryUrl);
  log.info('ACME requesting certificates for domains:', config.domains);

  // Generate or load account key
  if (!fs.existsSync(config.accountKeyFile)) {
    log.info('ACME AccountKey: generate', config.accountKeyFile);
    const accountKeypair = await Keypairs.generate({ kty: 'EC', format: 'jwk' });
    config.accountKey = accountKeypair.private;
    const pem = await Keypairs.export({ jwk: config.accountKey });
    await fs.promises.writeFile(config.accountKeyFile, pem, 'ascii');
  } else {
    log.info('ACME AccountKey: load', config.accountKeyFile);
    const pem = await fs.promises.readFile(config.accountKeyFile, 'ascii');
    config.accountKey = await Keypairs.import({ pem });
  }

  // Create or load account
  if (!fs.existsSync(config.accountFile)) {
    log.info('ACME Account: create', config.accountFile);
    config.account = await acme.accounts.create({ subscriberEmail: config.subscriber, agreeToTerms: true, accountKey: config.accountKey });
    await fs.promises.writeFile(config.accountFile, JSON.stringify(config.account), 'ascii');
  } else {
    log.info('ACME Account: load', config.accountFile);
    const json = await fs.promises.readFile(config.accountFile, JSON.stringify(config.account), 'ascii');
    config.account = JSON.parse(json);
  }

  // Generate or load server key
  if (!fs.existsSync(config.ServerKeyFile)) {
    log.info('ACME server key: generate', config.ServerKeyFile);
    const serverKeypair = await Keypairs.generate({ kty: 'RSA', format: 'jwk' });
    config.key = serverKeypair.private;
    const pem = await Keypairs.export({ jwk: config.key });
    await fs.promises.writeFile(config.ServerKeyFile, pem, 'ascii');
  } else {
    log.info('ACME server key: load', config.ServerKeyFile);
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
    const parsed = x509.parseCert(f);
    details.fullChain = { subject: parsed.subject.commonName, issuer: parsed.issuer.commonName, notBefore: new Date(parsed.notBefore), notAfter: new Date(parsed.notAfter) };
  } catch (err) {
    details.fullChain = { error: err };
  }
  try {
    const f = await fs.promises.readFile(config.accountFile, 'ascii');
    const json = JSON.parse(f);
    details.account = { contact: json.contact[0], initialIP: json.initialIp, createdAt: new Date(json.createdAt), status: json.status };
  } catch (err) {
    details.account = { error: err };
  }
  return details;
}

async function checkCert() {
  if (fs.existsSync(config.fullChain)) {
    if (initial) log.info('ACME certificate: check:', config.fullChain);
    const ssl = await parseCert();
    const now = new Date();
    if (!ssl.account || ssl.account.error) {
      log.warn(`ACME certificate account error: ${ssl.account.error || 'unknown'}`);
      return false;
    }
    if (!ssl.serverKey || ssl.serverKey.error || !ssl.accountKey || ssl.accountKey.error) {
      log.warn(`SSL keys error server:${ssl.serverKey.error} account:${ssl.account.error}`);
      return false;
    }
    if (!ssl.fullChain || ssl.fullChain.error) {
      log.warn(`SSL certificate error: ${ssl.fullChain.error}`);
      return false;
    }
    if (!ssl.fullChain.notBefore || (now - ssl.fullChain.notBefore < 0)) {
      log.warn(`ACME certificate invalid notBefore: ${ssl.fullChain.notBefore}`);
      return false;
    }
    if (!ssl.fullChain.notAfter || (now - ssl.fullChain.notAfter > 0)) {
      log.warn(`ACME certificate invalid notAfter: ${ssl.fullChain.notAfter}`);
      return false;
    }
    config.days = (ssl.fullChain.notAfter - now) / 1000 / 60 / 60 / 24;
    if (config.days > 3) return true;
    return false;
  }
  log.warn(`SSL certificate does not exist: ${config.fullChain}`);
  return false;
}

async function getCert() {
  const certOk = await checkCert(); // check existing cert for validity and expiration
  if (!certOk) {
    await createKeys(); // used to initialize account; typically genrates only once per server lifetime otherwise load existing
    await createCert(); // used to initialize certificate; typically genrates if cert doesn't exist or is about to expire
  }
  if (initial) {
    const ssl = await parseCert();
    if (ssl.account && !ssl.account.error) {
      log.info(`SSL account: ${ssl.account.contact} created: ${moment(ssl.account.createdAt).format('YYYY-MM-DD HH:mm:ss')} `);
    } else log.warn(`SSL account error: ${ssl.account.error}`);
    if (ssl.serverKey && !ssl.serverKey.error && ssl.accountKey && !ssl.accountKey.error) {
      log.info(`SSL keys server:${ssl.serverKey.type} account:${ssl.accountKey.type} `);
    } else log.warn(`SSL keys error server:${ssl.serverKey.error} account:${ssl.account.error}`);
    if (ssl.fullChain && !ssl.fullChain.error) {
      log.info(`SSL certificate subject:${ssl.fullChain.subject} issuer:${ssl.fullChain.issuer}`);
      // log.info(`SSL certificate notBefore:${moment(ssl.fullChain.notBefore).format('YYYY-MM-DD HH:mm:ss')} notAfter:${moment(ssl.fullChain.notAfter).format('YYYY-MM-DD HH:mm:ss')}`);
    } else log.warn(`SSL certificate error: ${ssl.fullChain.error}`);
    config.SSL = { Key: `../${config.ServerKeyFile}`, Crt: `../${config.fullChain}` };
    initial = false;
  }
  return config.SSL;
}

async function monitorCert() {
  await getCert();
  log.state(`SSL certificate expires in ${config.days.toFixed(1)} days, ${config.days <= 3 ? 'renewing now' : 'skipping renewal'}`);
  setTimeout(() => monitorCert(), 1000 * 60 * 60 * 12);
}

function initConfig(userConfig) {
  config = userConfig;
}

async function test() {
  await getCert();
  const details = await parseCert(); // parse any cert
  log.data('Parsed details:', details);
}

if (!module.parent) {
  test();
} else {
  exports.init = initConfig;
  exports.getCert = getCert;
  exports.parseCert = parseCert;
  exports.checkCert = checkCert;
  exports.createKeys = createKeys;
  exports.createCert = createCert;
  exports.monitorCert = monitorCert;
}
