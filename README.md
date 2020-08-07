# piacme

Simple ACME/LetsEncrypt HTTP/SSL Certificate Management

## Why

Because out of all of the existing modules, I couldn't find one that does what I needed and doesn't carry large number of unnecessary dependencies.  
This module is written in pure ES6 and requires only several low-level crypto management dependencies.

## Usage

Initialize PiACME by passing a configuration object:

    const config = {
      application: 'example/0.0.1',              // website or application signature, can be any string
      domains: ['example1.com', 'example2.com'], // list of domains for which we're getting a certificate for (same certificate can be used for multiple domain). must be resolvable and reachable over internet for validation before certificate can be issued.
      maintainer: 'maintainer@example.com',      // email of the person responsible for the site for which we're getting certificate for
      subscriber: 'subscriber@example.com',      // email of the person that will be registered with LetsEncrypt, can be the same as maintainer
      accountFile: './cert/account.json',        // file where account info will be stored once account is created
      accountKeyFile: './cert/account.pem',      // file where account secret will be stored once account is created
      ServerKeyFile: './cert//private.pem',      // file where server private key will be stored 
      fullChain: './cert/fullchain.pem',         // file where server certificate will be stored
    };

    const piacme = require('piacme');
    piacme.init(config);
    const { Key, Crt } = await acme.getCert();

That's it!  
Account registration, server key creation, certificate issuance, taget validation, and certificate renwal - are all handled automatically.
Now you can use server key and certificate.  
For example to start a secure **http2** server:

    const http2 = require('http2');
    const fs = require('fs');
    const options = {
      key = fs.readFileSync(Key);
      cert = fs.readFileSync(Crt);
    };
    const server = http2.createSecureServer(options);
    server.listen(443);

Or **https** server:

    const http2 = require('https');
    const fs = require('fs');
    const options = {
      key = fs.readFileSync(Key);
      cert = fs.readFileSync(Crt);
    };
    const server = https.createServer(options);
    server.listen(443);

## Internal workflow

All functions use same object passed during `init()` call.
Core function is `getCert()` and it will either return existing valid certificate, issue a new one or trigger a certificate renewal.

Internally, it calls `checkCert()` to verify if server key and certificate specified in config object already exists and are valid.  
If yes, it will just return those objects: `config.ServerKeyFile` and `config.fullChain`.  
If not, if calls:  

- `createKeys()`  
Which is used only once per server lifetime.  
It initialize LetsEncrypt account using maintainer info and generate server private key.
- `createCert()`  
Which is used to genrates new certificate if one doesn't exist or is about to expire.  
Interally it temporarily starts a http server on port 80 to listen for LetsEncrypt validation callbacks and then shuts down the server.

Next, it calls `parseCert()` and parses cetificate details for validity before returning server key and certificate.

## Optional

To monitor certificate, call `monitorCert()` which updates object initially passed using `init()` call by triggering `getCert()` every 12 hours.  
Usefull for certfificates with short lifespan that require freqent renewals.

    piacme.monitorCert();

(RFE: *Implement monitoring callback that can be used to automatically restart web server as needed*)

To get certificate details, call `parseCert()` and it will parse certificate from the initial object used during `init()` call.  

- `contact` and `subject` are values provided during certificate creation
- `error` in all cases is optional property and will be set if case of an error.  
- `issuer` will always be LetsEncrypt authority.  
- `createdAt`, `notBefore` and `notAfter` are date objects specifying certificate issue date and validity (start and end date).  

      const ssl = await piacme.parseCert();
      ssl: {
        account: { error?, contact, createdAt },
        serverKey: { error? },
        accountKey: { error? },
        fullChain: { error?, subject, issuer, notBefore, notAfter }
      }
