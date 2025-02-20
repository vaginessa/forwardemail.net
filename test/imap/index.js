/*
 * Copyright (c) Forward Email LLC
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file incorporates work covered by the following copyright and
 * permission notice:
 *
 *   WildDuck Mail Agent is licensed under the European Union Public License 1.2 or later.
 *   https://github.com/nodemailer/wildduck
 */

const { Buffer } = require('node:buffer');
const { createHash, randomUUID } = require('node:crypto');

// NOTE: wait command not supported by `ioredis-mock`
// <https://github.com/stipsan/ioredis-mock/issues/1327>
// const RedisMock = require('ioredis-mock');
const Axe = require('axe');
const Redis = require('@ladjs/redis');
const dayjs = require('dayjs-with-plugins');
const delay = require('delay');
const getPort = require('get-port');
const getStream = require('get-stream');
const ip = require('ip');
// const isCI = require('is-ci');
const ms = require('ms');
const openpgp = require('openpgp');
const pWaitFor = require('p-wait-for');
const splitLines = require('split-lines');
const test = require('ava');
const _ = require('lodash');
const { ImapFlow } = require('imapflow');
const { factory } = require('factory-girl');

const utils = require('../utils');
const SQLite = require('../../sqlite-server');
const IMAP = require('../../imap-server');

const Aliases = require('#models/aliases');
const Mailboxes = require('#models/mailboxes');
const Messages = require('#models/messages');
const config = require('#config');
const createWebSocketAsPromised = require('#helpers/create-websocket-as-promised');
const getDatabase = require('#helpers/get-database');
const { encrypt } = require('#helpers/encrypt-decrypt');
const createPassword = require('#helpers/create-password');

const logger = new Axe({ silent: true });
const IP_ADDRESS = ip.address();
const client = new Redis();
const subscriber = new Redis();
const tls = { rejectUnauthorized: false };

const INITIAL_DB_SIZE = 151552; // 159744;

subscriber.setMaxListeners(0);

test.before(utils.setupMongoose);
test.before(utils.defineUserFactory);
test.before(utils.defineDomainFactory);
test.before(utils.definePaymentFactory);
test.before(utils.defineAliasFactory);
//
// NOTE: we don't want to `client.flushall()`
//       because it will remove caching from mandarin
//       (and translations will need run from scratch again)
//
test.before(async () => {
  // imapLockNamespace
  // smtpLimitNamespace
  const [imapLockKeys, smtpLimitKeys] = await Promise.all([
    client.keys(`${config.imapLockNamespace}*`),
    client.keys(`${config.smtpLimitNamespace}*`)
  ]);
  await Promise.all([
    imapLockKeys.map((k) => client.del(k)),
    smtpLimitKeys.map((k) => client.del(k))
  ]);
});
test.after.always(utils.teardownMongoose);
test.beforeEach(async (t) => {
  const secure = false;
  t.context.secure = secure;
  const port = await getPort();
  const sqlitePort = await getPort();
  const sqlite = new SQLite({ client, subscriber });
  t.context.sqlite = sqlite;
  await sqlite.listen(sqlitePort);
  const wsp = createWebSocketAsPromised({
    port: sqlitePort
  });
  t.context.wsp = wsp;
  const imap = new IMAP({ client, subscriber, wsp }, secure);
  t.context.port = port;
  t.context.server = await imap.listen(port);
  t.context.imap = imap;

  const user = await factory.create('user', {
    plan: 'enhanced_protection',
    [config.userFields.planSetAt]: dayjs().startOf('day').toDate()
  });

  await factory.create('payment', {
    user: user._id,
    amount: 300,
    invoice_at: dayjs().startOf('day').toDate(),
    method: 'free_beta_program',
    duration: ms('30d'),
    plan: user.plan,
    kind: 'one-time'
  });

  t.context.user = await user.save();

  const domain = await factory.create('domain', {
    members: [{ user: user._id, group: 'admin' }],
    plan: user.plan,
    resolver: imap.resolver,
    has_smtp: true
  });

  t.context.domain = domain;

  const alias = await factory.create('alias', {
    user: user._id,
    domain: domain._id,
    recipients: [user.email],
    has_imap: true
  });

  const pass = await alias.createToken();
  t.context.pass = pass;
  t.context.alias = await alias.save();

  // spoof session
  t.context.session = {
    user: {
      id: alias.id,
      username: `${alias.name}@${domain.name}`,
      alias_id: alias.id,
      alias_name: alias.name,
      domain_id: domain.id,
      domain_name: domain.name,
      password: encrypt(pass),
      storage_location: alias.storage_location,
      alias_has_pgp: alias.has_pgp,
      alias_public_key: alias.public_key,
      locale: 'en',
      owner_full_email: `${alias.name}@${domain.name}`
    }
  };

  // spoof dns records
  const map = new Map();
  map.set(
    `txt:${domain.name}`,
    imap.resolver.spoofPacket(
      domain.name,
      'TXT',
      [`${config.paidPrefix}${domain.verification_record}`],
      true
    )
  );

  // store spoofed dns cache
  await imap.resolver.options.cache.mset(map);

  const imapFlow = new ImapFlow({
    host: IP_ADDRESS,
    port,
    secure,
    logger,
    tls,
    auth: {
      user: `${alias.name}@${domain.name}`,
      pass
    }
  });

  await imapFlow.connect();

  t.context.imapFlow = imapFlow;

  // create inbox
  await t.context.imapFlow.mailboxCreate('INBOX');
  await getDatabase(imap, alias, t.context.session);
  const mailbox = await Mailboxes.findOne(t.context.imap, t.context.session, {
    path: 'INBOX'
  });
  t.is(mailbox.specialUse, '\\Inbox');
  t.is(mailbox.uidNext, 1);
});

test.afterEach(async (t) => {
  await t.context.imapFlow.logout();
  await t.context.imap.close();
});

test('prevents domain-wide passwords', async (t) => {
  const { domain } = t.context;
  const { password, salt, hash } = await createPassword();
  domain.tokens.push({
    description: 'test',
    salt,
    hash,
    user: t.context.user._id
  });
  domain.locale = 'en';
  domain.resolver = t.context.imap.resolver;
  domain.skip_verification = true;
  await domain.save();
  const imapFlow = new ImapFlow({
    host: IP_ADDRESS,
    port: t.context.port,
    secure: t.context.secure,
    logger,
    tls,
    auth: {
      user: `test@${domain.name}`,
      pass: password
    }
  });
  const err = await t.throwsAsync(imapFlow.connect());
  t.true(err.authenticationFailed);
  t.regex(err.response, /Alias does not exist/);
});

test('onAppend with private PGP', async (t) => {
  // creates unique user/domain/alias
  // (otherwise would interfere with other tests)
  const user = await factory.create('user', {
    plan: 'enhanced_protection',
    [config.userFields.planSetAt]: dayjs().startOf('day').toDate()
  });

  await factory.create('payment', {
    user: user._id,
    amount: 300,
    invoice_at: dayjs().startOf('day').toDate(),
    method: 'free_beta_program',
    duration: ms('30d'),
    plan: user.plan,
    kind: 'one-time'
  });

  await user.save();

  const domain = await factory.create('domain', {
    members: [{ user: user._id, group: 'admin' }],
    plan: user.plan,
    resolver: t.context.imap.resolver,
    has_smtp: true
  });

  const alias = await factory.create('alias', {
    user: user._id,
    domain: domain._id,
    recipients: [user.email]
  });

  const pass = await alias.createToken();
  await alias.save();

  const { publicKey } = await openpgp.generateKey({
    type: 'ecc', // Type of the key, defaults to ECC
    curve: 'curve25519', // ECC curve name, defaults to curve25519
    userIDs: [{ name: '', email: `${alias.name}@${domain.name}` }], // you can pass multiple user IDs
    passphrase: 'super long and hard to guess secret', // protects the private key
    format: 'armored' // output key format, defaults to 'armored' (other options: 'binary' or 'object')
  });

  alias.has_pgp = true;
  alias.public_key = publicKey;
  await alias.save();

  const session = {
    user: {
      id: alias.id,
      username: `${alias.name}@${domain.name}`,
      alias_id: alias.id,
      alias_name: alias.name,
      domain_id: domain.id,
      domain_name: domain.name,
      password: encrypt(pass),
      storage_location: alias.storage_location,
      alias_has_pgp: alias.has_pgp,
      alias_public_key: alias.public_key,
      locale: 'en',
      owner_full_email: `${alias.name}@${domain.name}`
    }
  };

  await getDatabase(t.context.imap, alias, session);

  // spoof dns records
  const map = new Map();
  map.set(
    `txt:${domain.name}`,
    t.context.imap.resolver.spoofPacket(
      domain.name,
      'TXT',
      [`${config.paidPrefix}${domain.verification_record}`],
      true
    )
  );

  // store spoofed dns cache
  await t.context.imap.resolver.options.cache.mset(map);

  const imapFlow = new ImapFlow({
    host: IP_ADDRESS,
    port: t.context.port,
    secure: t.context.secure,
    logger,
    tls,
    auth: {
      user: `${alias.name}@${domain.name}`,
      pass
    }
  });

  await imapFlow.connect();

  //
  // `mailboxCreate(path)` whereas `path` is parsed by `normalizePath` function
  // <https://github.com/postalsys/imapflow/blob/d48d0d84e169d0c4315e32d1d565c08f382cace7/lib/tools.js#L36-L52>
  //
  await imapFlow.mailboxCreate('append-with-private-pgp');

  let mailbox = await Mailboxes.findOne(t.context.imap, session, {
    path: 'append-with-private-pgp'
  });

  if (!mailbox) throw new Error('Mailbox does not exist');

  const raw = `
Content-Type: multipart/mixed; boundary="------------cWFvDSey27tFG0hVYLqp9hs9"
MIME-Version: 1.0
To: ${alias.name}@${domain.name}
From: ${alias.name}@${domain.name}
Subject: test

This is a multi-part message in MIME format.
--------------cWFvDSey27tFG0hVYLqp9hs9
Content-Type: text/plain; charset=UTF-8; format=flowed
Content-Transfer-Encoding: 7bit

test

--------------cWFvDSey27tFG0hVYLqp9hs9
Content-Type: text/plain; charset=UTF-8; name="example.txt"
Content-Disposition: attachment; filename="example.txt"
Content-Transfer-Encoding: base64

ZXhhbXBsZQo=

--------------cWFvDSey27tFG0hVYLqp9hs9--`.trim();

  const append = await imapFlow.append(
    'append-with-private-pgp',
    Buffer.from(raw),
    ['\\Seen'],
    new Date()
  );

  // <https://github.com/postalsys/imapflow/issues/146#issuecomment-1747958257>
  t.is(append.destination, 'append-with-private-pgp');
  t.is(append.uid, 1);
  t.is(append.uidValidity, BigInt(mailbox.uidValidity));

  mailbox = await Mailboxes.findById(t.context.imap, session, mailbox._id);

  t.is(mailbox.uidNext, 2);

  // ensure PGP encrypted message was stored
  const msg = await Messages.findOne(t.context.imap, session, {
    mailbox: mailbox._id,
    uid: append.uid
  });
  t.is(
    msg.mimeTree.body.toString().trim(),
    'This is an OpenPGP/MIME encrypted message'
  );
});

/*
test('onAppend with public PGP', async (t) => {
  // creates unique user/domain/alias
  // (otherwise would interfere with other tests)
  const user = await factory.create('user', {
    plan: 'enhanced_protection',
    [config.userFields.planSetAt]: dayjs().startOf('day').toDate()
  });

  await factory.create('payment', {
    user: user._id,
    amount: 300,
    invoice_at: dayjs().startOf('day').toDate(),
    method: 'free_beta_program',
    duration: ms('30d'),
    plan: user.plan,
    kind: 'one-time'
  });

  await user.save();

  const domain = await factory.create('domain', {
    // NOTE: this is a known email with openpgp
    name: 'forwardemail.net',
    members: [{ user: user._id, group: 'admin' }],
    plan: user.plan,
    resolver: t.context.imap.resolver,
    has_smtp: true
  });

  const alias = await factory.create('alias', {
    // NOTE: this is a known email with openpgp
    name: 'support',
    user: user._id,
    domain: domain._id,
    recipients: [user.email]
  });

  const pass = await alias.createToken();
  await alias.save();

  const session = {
    user: {
      id: alias.id,
      username: `${alias.name}@${domain.name}`,
      alias_id: alias.id,
      alias_name: alias.name,
      domain_id: domain.id,
      domain_name: domain.name,
      password: encrypt(pass),
      storage_location: alias.storage_location,
      alias_has_pgp: alias.has_pgp,
      alias_public_key: alias.public_key,
      locale: 'en',
      owner_full_email: `${alias.name}@${domain.name}`
    }
  };

  await getDatabase(t.context.imap, alias, session);

  // spoof dns records
  const map = new Map();
  map.set(
    `txt:${domain.name}`,
    t.context.imap.resolver.spoofPacket(
      domain.name,
      'TXT',
      [`${config.paidPrefix}${domain.verification_record}`],
      true
    )
  );

  // store spoofed dns cache
  await t.context.imap.resolver.options.cache.mset(map);

  const imapFlow = new ImapFlow({
    host: IP_ADDRESS,
    port: t.context.port,
    secure: t.context.secure,
    logger,
    tls,
    auth: {
      user: `${alias.name}@${domain.name}`,
      pass
    }
  });

  await imapFlow.connect();

  //
  // `mailboxCreate(path)` whereas `path` is parsed by `normalizePath` function
  // <https://github.com/postalsys/imapflow/blob/d48d0d84e169d0c4315e32d1d565c08f382cace7/lib/tools.js#L36-L52>
  //
  await imapFlow.mailboxCreate('append-with-public-pgp');

  let mailbox = await Mailboxes.findOne(t.context.imap, session, {
    path: 'append-with-public-pgp'
  });

  if (!mailbox) throw new Error('Mailbox does not exist');

  const raw = `
Content-Type: multipart/mixed; boundary="------------cWFvDSey27tFG0hVYLqp9hs9"
MIME-Version: 1.0
To: ${alias.name}@${domain.name}
From: ${alias.name}@${domain.name}
Subject: test

This is a multi-part message in MIME format.
--------------cWFvDSey27tFG0hVYLqp9hs9
Content-Type: text/plain; charset=UTF-8; format=flowed
Content-Transfer-Encoding: 7bit

test

--------------cWFvDSey27tFG0hVYLqp9hs9
Content-Type: text/plain; charset=UTF-8; name="example.txt"
Content-Disposition: attachment; filename="example.txt"
Content-Transfer-Encoding: base64

ZXhhbXBsZQo=

--------------cWFvDSey27tFG0hVYLqp9hs9--`.trim();

  const append = await imapFlow.append(
    'append-with-public-pgp',
    Buffer.from(raw),
    ['\\Seen'],
    new Date()
  );

  // <https://github.com/postalsys/imapflow/issues/146#issuecomment-1747958257>
  t.is(append.destination, 'append-with-public-pgp');
  t.is(append.uid, 1);
  t.is(append.uidValidity, BigInt(mailbox.uidValidity));

  mailbox = await Mailboxes.findById(t.context.imap, session, mailbox._id);

  t.is(mailbox.uidNext, 2);

  // ensure PGP encrypted message was stored
  const msg = await Messages.findOne(t.context.imap, session, {
    mailbox: mailbox._id,
    uid: append.uid
  });
  t.is(
    msg.mimeTree.body.toString().trim(),
    'This is an OpenPGP/MIME encrypted message'
  );
});
*/

test('onAppend', async (t) => {
  const { imapFlow, alias, domain } = t.context;

  //
  // `mailboxCreate(path)` whereas `path` is parsed by `normalizePath` function
  // <https://github.com/postalsys/imapflow/blob/d48d0d84e169d0c4315e32d1d565c08f382cace7/lib/tools.js#L36-L52>
  //
  await imapFlow.mailboxCreate('append');

  let mailbox = await Mailboxes.findOne(t.context.imap, t.context.session, {
    path: 'append'
  });

  const raw = `
Content-Type: multipart/mixed; boundary="------------cWFvDSey27tFG0hVYLqp9hs9"
MIME-Version: 1.0
To: ${alias.name}@${domain.name}
From: ${alias.name}@${domain.name}
Subject: test

This is a multi-part message in MIME format.
--------------cWFvDSey27tFG0hVYLqp9hs9
Content-Type: text/plain; charset=UTF-8; format=flowed
Content-Transfer-Encoding: 7bit

test

--------------cWFvDSey27tFG0hVYLqp9hs9
Content-Type: text/plain; charset=UTF-8; name="example.txt"
Content-Disposition: attachment; filename="example.txt"
Content-Transfer-Encoding: base64

ZXhhbXBsZQo=

--------------cWFvDSey27tFG0hVYLqp9hs9--`.trim();

  const append = await imapFlow.append(
    'append',
    Buffer.from(raw),
    ['\\Seen'],
    new Date()
  );

  // <https://github.com/postalsys/imapflow/issues/146#issuecomment-1747958257>
  t.is(append.destination, 'append');
  t.is(append.uid, 1);
  t.is(append.uidValidity, BigInt(mailbox.uidValidity));

  mailbox = await Mailboxes.findById(
    t.context.imap,
    t.context.session,
    mailbox._id
  );

  t.is(mailbox.uidNext, 2);
});

test('onCreate', async (t) => {
  const mailbox = await t.context.imapFlow.mailboxCreate('beep');
  t.deepEqual(mailbox, {
    path: 'beep',
    created: true
  });
});

test('onFetch', async (t) => {
  const client = new ImapFlow({
    host: IP_ADDRESS,
    port: t.context.port,
    secure: t.context.secure,
    logger,
    tls,
    auth: {
      user: `${t.context.alias.name}@${t.context.domain.name}`,
      pass: t.context.pass
    }
  });
  await client.connect();

  // create mailbox folder
  const mbox = await client.mailboxCreate(['INBOX', 'fetch', 'child']);
  t.is(mbox.path, 'INBOX/fetch/child');
  const mailbox = await Mailboxes.findOne(t.context.imap, t.context.session, {
    path: 'INBOX/fetch/child'
  });
  t.true(typeof mailbox === 'object');
  t.is(mailbox.path, 'INBOX/fetch/child');

  //
  // write a bunch of messages to the mailbox (with and without attachments)
  //
  await Promise.all(
    // 5 x 2 = 10
    Array.from({ length: 5 }).map((k, i) => {
      const raw1 = `
Message-ID: <f869239d-3a31-4cb1-b30a-8a697252beb3@forwardemail.net>
Date: ${new Date().toISOString()}
MIME-Version: 1.0
Content-Language: en-US
To: ${t.context.alias.name}@${t.context.domain.name}
From: ${t.context.alias.name}@${t.context.domain.name}
Subject: test-${i}
Content-Type: text/plain; charset=UTF-8; format=flowed
Content-Transfer-Encoding: 7bit

test
`.trim();

      const raw2 = `
Content-Type: multipart/mixed; boundary="------------cWFvDSey27tFG0hVYLqp9hs9"
MIME-Version: 1.0
To: ${t.context.alias.name}@${t.context.domain.name}
From: ${t.context.alias.name}@${t.context.domain.name}
Subject: test-${i}

This is a multi-part message in MIME format.
--------------cWFvDSey27tFG0hVYLqp9hs9
Content-Type: text/plain; charset=UTF-8; format=flowed
Content-Transfer-Encoding: 7bit

test-${i}

--------------cWFvDSey27tFG0hVYLqp9hs9
Content-Type: text/plain; charset=UTF-8; name="example.txt"
Content-Disposition: attachment; filename="example.txt"
Content-Transfer-Encoding: base64

ZXhhbXBsZQo=

--------------cWFvDSey27tFG0hVYLqp9hs9--`.trim();

      return Promise.all([
        client.append('INBOX/fetch/child', Buffer.from(raw1), [], new Date()),
        client.append('INBOX/fetch/child', Buffer.from(raw2), [], new Date())
      ]);
    })
  );

  const lock = await client.getMailboxLock('INBOX/fetch/child');

  try {
    // fetchOne
    // `exists` is the largest seq number available in mailbox

    // NOTE: we don't store `raw` anymore so this test won't work
    /*
    const message = await client.fetchOne(client.mailbox.exists, {
      source: true
    });
    const msg = await Messages.findOne(t.context.imap, t.context.session, {
      mailbox: mailbox._id,
      uid: message.uid
    });
    t.is(
      message.source.toString(),
      splitLines(msg.raw.toString()).join('\r\n')
    );
    */

    // fetch
    // uid is always included, envelope strings are in unicode
    for await (const message of client.fetch('1:*', { envelope: true })) {
      // NOTE: since emailId not working (should be message.id from db)
      t.is(
        message.id,
        createHash('md5')
          .update(
            [
              mailbox.path,
              mailbox.uidValidity.toString(),
              message.uid.toString()
            ].join(':')
          )
          .digest('hex')
      );
    }

    // fetch (with search)
    for await (const message of client.fetch(
      {
        or: [{ to: `${t.context.alias.name}@${t.context.domain.name}` }]
      },
      { envelope: true, uid: true },
      { uid: true }
    )) {
      // NOTE: since emailId not working (should be message.id from db)
      t.is(
        message.id,
        createHash('md5')
          .update(
            [
              mailbox.path,
              mailbox.uidValidity.toString(),
              message.uid.toString()
            ].join(':')
          )
          .digest('hex')
      );
    }
  } finally {
    lock.release();
  }

  // cleanup
  await client.logout();
});

test('onSubscribe', async (t) => {
  await t.context.imapFlow.mailboxCreate('subscribe');
  const z = await t.context.imapFlow.mailboxSubscribe('subscribe');
  t.is(z, true);
  const f = await t.context.imapFlow.mailboxSubscribe('subscribeFail');
  t.is(f, false);
});

test('onUnsubscribe', async (t) => {
  await t.context.imapFlow.mailboxCreate('unsubscribe');
  t.is(await t.context.imapFlow.mailboxSubscribe('unsubscribe'), true);
  t.is(await t.context.imapFlow.mailboxUnsubscribe('unsubscribe'), true);
  t.is(await t.context.imapFlow.mailboxUnsubscribe('unsubscribe'), true);
});

test('onGetQuotaRoot', async (t) => {
  // creates unique user/domain/alias for quota
  // (otherwise would interfere with other tests)
  const user = await factory.create('user', {
    plan: 'enhanced_protection',
    [config.userFields.planSetAt]: dayjs().startOf('day').toDate()
  });

  await factory.create('payment', {
    user: user._id,
    amount: 300,
    invoice_at: dayjs().startOf('day').toDate(),
    method: 'free_beta_program',
    duration: ms('30d'),
    plan: user.plan,
    kind: 'one-time'
  });

  await user.save();

  const domain = await factory.create('domain', {
    members: [{ user: user._id, group: 'admin' }],
    plan: user.plan,
    resolver: t.context.imap.resolver,
    has_smtp: true
  });

  const alias = await factory.create('alias', {
    user: user._id,
    domain: domain._id,
    recipients: [user.email]
  });

  const pass = await alias.createToken();
  await alias.save();

  // spoof dns records
  const map = new Map();
  map.set(
    `txt:${domain.name}`,
    t.context.imap.resolver.spoofPacket(
      domain.name,
      'TXT',
      [`${config.paidPrefix}${domain.verification_record}`],
      true
    )
  );

  // store spoofed dns cache
  await t.context.imap.resolver.options.cache.mset(map);

  const imapFlow = new ImapFlow({
    host: IP_ADDRESS,
    port: t.context.port,
    secure: t.context.secure,
    logger,
    tls,
    auth: {
      user: `${alias.name}@${domain.name}`,
      pass
    }
  });

  await imapFlow.connect();

  {
    await delay(ms('1s'));
    await t.context.wsp.request({
      action: 'size',
      timeout: ms('5s'),
      alias_id: alias.id
    });

    const storageUsed = await Aliases.getStorageUsed(alias);
    t.is(storageUsed, INITIAL_DB_SIZE);
    const quota = await t.context.imapFlow.getQuota();
    t.is(quota.path, 'INBOX');
    t.is(quota.storage.limit, config.maxQuotaPerAlias);
    t.is(quota.storage.status, '0%');
    if (![159744, INITIAL_DB_SIZE].includes(quota.storage.usage))
      t.fail('Quota storage is off');
    // TODO: figure out why INITIAL_DB_SIZE is sometimes off here (e.g. its sometimes 159744)
    // t.deepEqual(quota, {
    //   path: 'INBOX',
    //   storage: {
    //     usage: INITIAL_DB_SIZE, // isCI ? 159744 : INITIAL_DB_SIZE,
    //     limit: config.maxQuotaPerAlias,
    //     status: '0%'
    //   }
    // });
  }

  await imapFlow.mailboxCreate('boopboop');

  const mailboxes = await imapFlow.list();
  t.log('mailboxes', mailboxes);

  {
    await delay(ms('1s'));
    await t.context.wsp.request({
      action: 'size',
      timeout: ms('5s'),
      alias_id: alias.id
    });
    const storageUsed = await Aliases.getStorageUsed(alias);
    t.is(storageUsed, 159744);
    const quota = await imapFlow.getQuota('boopboop');
    t.deepEqual(quota, {
      path: 'boopboop',
      storage: {
        usage: 159744,
        limit: config.maxQuotaPerAlias,
        status: '0%'
      }
    });
  }

  t.is(await imapFlow.getQuota('beepdoesnotexist'), false);

  // add a message to ensure quota used
  const raw = `
Content-Type: multipart/mixed; boundary="------------cWFvDSey27tFG0hVYLqp9hs9"
MIME-Version: 1.0
To: ${alias.name}@${domain.name}
From: ${alias.name}@${domain.name}
Subject: test

This is a multi-part message in MIME format.
--------------cWFvDSey27tFG0hVYLqp9hs9
Content-Type: text/plain; charset=UTF-8; format=flowed
Content-Transfer-Encoding: 7bit

test

--------------cWFvDSey27tFG0hVYLqp9hs9
Content-Type: text/plain; charset=UTF-8; name="example.txt"
Content-Disposition: attachment; filename="example.txt"
Content-Transfer-Encoding: base64

ZXhhbXBsZQo=

--------------cWFvDSey27tFG0hVYLqp9hs9--`.trim();

  const append = await imapFlow.append(
    'boopboop',
    Buffer.from(raw),
    ['\\Seen'],
    new Date()
  );

  const session = {
    user: {
      id: alias.id,
      username: `${alias.name}@${domain.name}`,
      alias_id: alias.id,
      alias_name: alias.name,
      domain_id: domain.id,
      domain_name: domain.name,
      password: encrypt(pass),
      storage_location: alias.storage_location,
      alias_has_pgp: alias.has_pgp,
      alias_public_key: alias.public_key,
      locale: 'en',
      owner_full_email: `${alias.name}@${domain.name}`
    }
  };

  await getDatabase(t.context.imap, alias, session);

  const mailbox = await Mailboxes.findOne(t.context.imap, session, {
    path: append.destination
  });

  t.is(mailbox.path, append.destination);

  {
    await delay(ms('1s'));
    await t.context.wsp.request({
      action: 'size',
      timeout: ms('5s'),
      alias_id: alias.id
    });
    // const message = await Messages.findOne(t.context.imap, session, {
    //   mailbox: mailbox._id,
    //   uid: append.uid
    // });
    const storageUsed = await Aliases.getStorageUsed(alias);
    t.is(storageUsed, 159744);
    const quota = await imapFlow.getQuota('boopboop');
    t.deepEqual(quota, {
      path: 'boopboop',
      storage: {
        // message size is rounded to nearest 1024 bytes
        usage: 159744,
        limit: config.maxQuotaPerAlias,
        status: '0%'
      }
    });
  }
});

test('onGetQuota', async (t) => {
  await delay(ms('1s'));
  await t.context.wsp.request({
    action: 'size',
    timeout: ms('5s'),
    alias_id: t.context.alias.id
  });
  const quota = await t.context.imapFlow.getQuota();
  t.deepEqual(quota, {
    path: 'INBOX',
    storage: {
      usage: 159744, // INITIAL_DB_SIZE,
      limit: config.maxQuotaPerAlias,
      status: '0%'
    }
  });
});

test('onCopy', async (t) => {
  // create a bunch of messages in copy folder
  await t.context.imapFlow.mailboxCreate('copy');
  for (let i = 0; i < 10; i++) {
    const raw = `
Date: ${new Date().toISOString()}
MIME-Version: 1.0
Content-Language: en-US
To: ${t.context.alias.name}@${t.context.domain.name}
From: ${t.context.alias.name}@${t.context.domain.name}
Subject: test-${i}
Content-Type: text/plain; charset=UTF-8; format=flowed
Content-Transfer-Encoding: 7bit

test
`.trim();

    // eslint-disable-next-line no-await-in-loop
    await t.context.imapFlow.append('copy', Buffer.from(raw), [], new Date());
  }

  // connect to mailbox
  await t.context.imapFlow.mailboxOpen('copy');

  // attempt to copy messages to "backup" folder
  // when it doesn't yet exist results in a fail (false)
  t.is(await t.context.imapFlow.messageCopy('1:*', 'backup'), false);

  // copy all messages to a mailbox called "Backup" (must exist)
  await t.context.imapFlow.mailboxCreate('backup');
  const result = await t.context.imapFlow.messageCopy('1:*', 'backup');
  t.is(result.path, 'copy');
  t.is(result.destination, 'backup');
  t.is(result.uidMap.size, 10);
});

// delete removes an entire mailbox
test('onDelete', async (t) => {
  const err = await t.throwsAsync(t.context.imapFlow.mailboxDelete('BOOPBAZ'));
  t.is(err.message, 'Command failed');
  t.regex(err.response, /NO \[NONEXISTENT] DELETE completed/);
  t.is(err.responseStatus, 'NO');
  t.is(err.responseText, 'DELETE completed');
  t.is(err.serverResponseCode, 'NONEXISTENT');
  await t.context.imapFlow.mailboxCreate('WUHWOH');
  await t.context.imapFlow.mailboxDelete('WUHWOH');

  // now attempt to create a mailbox with messages and delete it
  await t.context.imapFlow.mailboxCreate('DELETE-WITH-MESSAGES');
  const raw = `
Content-Type: multipart/mixed; boundary="------------cWFvDSey27tFG0hVYLqp9hs9"
MIME-Version: 1.0
To: ${t.context.alias.name}@${t.context.domain.name}
From: ${t.context.alias.name}@${t.context.domain.name}
Subject: test

This is a multi-part message in MIME format.
--------------cWFvDSey27tFG0hVYLqp9hs9
Content-Type: text/plain; charset=UTF-8; format=flowed
Content-Transfer-Encoding: 7bit

test

--------------cWFvDSey27tFG0hVYLqp9hs9
Content-Type: text/plain; charset=UTF-8; name="example.txt"
Content-Disposition: attachment; filename="example.txt"
Content-Transfer-Encoding: base64

ZXhhbXBsZQo=

--------------cWFvDSey27tFG0hVYLqp9hs9--`.trim();
  await t.context.imapFlow.append(
    'DELETE-WITH-MESSAGES',
    Buffer.from(raw),
    ['\\Seen'],
    new Date()
  );
  await t.context.imapFlow.append(
    'DELETE-WITH-MESSAGES',
    Buffer.from(raw),
    ['\\Seen'],
    new Date()
  );
  await t.context.imapFlow.append(
    'DELETE-WITH-MESSAGES',
    Buffer.from(raw),
    ['\\Seen'],
    new Date()
  );
  await t.context.imapFlow.append(
    'DELETE-WITH-MESSAGES',
    Buffer.from(raw),
    ['\\Seen'],
    new Date()
  );
  await t.context.imapFlow.mailboxDelete('DELETE-WITH-MESSAGES');
});

// expunge deletes messages
test('onExpunge', async (t) => {
  await t.context.imapFlow.mailboxCreate('expunge');

  const raw = `
Content-Type: multipart/mixed; boundary="------------cWFvDSey27tFG0hVYLqp9hs9"
MIME-Version: 1.0
To: ${t.context.alias.name}@${t.context.domain.name}
From: ${t.context.alias.name}@${t.context.domain.name}
Subject: test

This is a multi-part message in MIME format.
--------------cWFvDSey27tFG0hVYLqp9hs9
Content-Type: text/plain; charset=UTF-8; format=flowed
Content-Transfer-Encoding: 7bit

test

--------------cWFvDSey27tFG0hVYLqp9hs9
Content-Type: text/plain; charset=UTF-8; name="example.txt"
Content-Disposition: attachment; filename="example.txt"
Content-Transfer-Encoding: base64

ZXhhbXBsZQo=

--------------cWFvDSey27tFG0hVYLqp9hs9--`.trim();

  await t.context.imapFlow.append(
    'expunge',
    Buffer.from(raw),
    ['\\Seen'],
    new Date()
  );

  const mailbox = await Mailboxes.findOne(t.context.imap, t.context.session, {
    path: 'expunge'
  });

  t.is(mailbox.path, 'expunge');

  // note that a message won't get marked as deleted
  // since it has to have a Deleted flag at first
  const uids = await Messages.distinct(
    t.context.imap,
    t.context.session,
    'uid',
    {
      mailbox: mailbox._id,
      undeleted: true
    }
  );

  t.is(uids.length, 1);

  await t.context.imapFlow.mailboxOpen('expunge');

  const result = await t.context.imapFlow.messageFlagsAdd(
    uids,
    ['\\Deleted', 'NonJunk'],
    // <https://github.com/postalsys/imapflow/issues/21#issuecomment-658773009>
    { uid: true }
  );
  t.true(result);

  let data;
  t.context.imapFlow.on('expunge', (_data) => {
    data = _data;
  });

  const res = await t.context.imapFlow.messageDelete({ all: true });

  t.true(res);

  if (!data) await pWaitFor(() => Boolean(data), { timeout: ms('5s') });

  t.is(data.path, 'expunge');
  t.is(data.vanished, false);
  t.is(data.seq, 1);
});

// NOTE: onLsub is taken care of by onSubscribe and unSubscribe
// test('onLsub', async (t) => {});

test('onMove', async (t) => {
  // create a bunch of messages in move folder
  await t.context.imapFlow.mailboxCreate('move');
  for (let i = 0; i < 10; i++) {
    const raw = `
Date: ${new Date().toISOString()}
MIME-Version: 1.0
Content-Language: en-US
To: ${t.context.alias.name}@${t.context.domain.name}
From: ${t.context.alias.name}@${t.context.domain.name}
Subject: test-${i}
Content-Type: text/plain; charset=UTF-8; format=flowed
Content-Transfer-Encoding: 7bit

test
`.trim();

    // eslint-disable-next-line no-await-in-loop
    await t.context.imapFlow.append('move', Buffer.from(raw), [], new Date());
  }

  // connect to mailbox
  await t.context.imapFlow.mailboxOpen('move');

  // attempt to move messages to "was-moved" folder
  // when it doesn't yet exist results in a fail (false)
  t.is(await t.context.imapFlow.messageMove('1:*', 'was-moved'), false);

  // move all messages to a mailbox called "was-moved" (ust exist)
  await t.context.imapFlow.mailboxCreate('was-moved');
  const result = await t.context.imapFlow.messageMove('1:*', 'was-moved');
  t.log('result', result);
  t.is(result.path, 'move');
  t.is(result.destination, 'was-moved');
  t.is(result.uidMap.size, 10);
});

test('onOpen', async (t) => {
  await t.context.imapFlow.mailboxCreate('opened');
  const result = await t.context.imapFlow.mailboxOpen('opened');
  t.is(result.path, 'opened');
});

test('onRename', async (t) => {
  await t.context.imapFlow.mailboxCreate(['parent', 'child']);
  const info = await t.context.imapFlow.mailboxRename(
    'parent/child',
    'important'
  );
  t.is(info.path, 'parent/child');
  t.is(info.newPath, 'important');
});

test('onSearch', async (t) => {
  await t.context.imapFlow.mailboxCreate('searchwoowoo');

  // create a bunch of seen and unseen messages
  for (let i = 0; i < 10; i++) {
    const raw = `
Date: ${new Date().toISOString()}
MIME-Version: 1.0
Content-Language: en-US
To: ${t.context.alias.name}@${t.context.domain.name}
From: Linus <${t.context.alias.name}@${t.context.domain.name}>
Subject: Beep Baz Boop unseen-test-${i}
Content-Type: text/plain; charset=UTF-8; format=flowed
Content-Transfer-Encoding: 7bit

test Snap Ya Ya Ya
`.trim();

    // eslint-disable-next-line no-await-in-loop
    await t.context.imapFlow.append(
      'searchwoowoo',
      Buffer.from(raw),
      [],
      new Date()
    );
  }

  for (let i = 0; i < 10; i++) {
    const raw = `
Date: ${new Date().toISOString()}
MIME-Version: 1.0
Content-Language: en-US
To: ${t.context.alias.name}@${t.context.domain.name}
From: ${t.context.alias.name}@${t.context.domain.name}
Subject: seen-test-${i}
Content-Type: text/plain; charset=UTF-8; format=flowed
Content-Transfer-Encoding: 7bit

test
`.trim();

    // eslint-disable-next-line no-await-in-loop
    await t.context.imapFlow.append(
      'searchwoowoo',
      Buffer.from(raw),
      ['\\Seen'],
      new Date()
    );
  }

  await t.context.imapFlow.mailboxOpen('searchwoowoo');

  // find all unseen messages
  const list1 = await t.context.imapFlow.search({ seen: true });
  // use OR modifier (array of 2 or more search queries)
  const list2 = await t.context.imapFlow.search({
    seen: false,
    or: [{ flagged: true }, { from: 'linus' }]
  });
  t.is(list1.length, 10);
  t.is(list2.length, 10);
  t.notDeepEqual(list1, list2);

  //
  // iterate over all possible search params for maximum coverage
  // (we can further refine this in the future)
  //

  // booleans
  for (const key of [
    'answered',
    'deleted',
    'draft',
    'flagged',
    'seen',
    'all',
    'new',
    'old',
    'recent'
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await t.context.imapFlow.search({ [key]: false });
    // eslint-disable-next-line no-await-in-loop
    await t.context.imapFlow.search({ [key]: true });
  }

  // strings (e.g. $text search)
  for (const key of [
    'to',
    'from',
    'cc',
    'bcc',
    'text',
    'body',
    'subject',
    'keyword',
    'unKeyword' // TODO: (?)
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await t.context.imapFlow.search({ [key]: 'test' });
  }

  // size
  for (const key of ['larger', 'smaller']) {
    // eslint-disable-next-line no-await-in-loop
    await t.context.imapFlow.search({ [key]: 100 });
  }

  // dates
  for (const key of [
    'before',
    'on',
    'since',
    'sentBefore',
    'sentOn',
    'sentSince'
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await t.context.imapFlow.search({ [key]: new Date(Date.now() + 10000) });
  }
});

test('onStatus', async (t) => {
  await t.context.imapFlow.mailboxCreate('yoyo');

  // create a bunch of seen and unseen messages
  for (let i = 0; i < 10; i++) {
    const raw = `
Date: ${new Date().toISOString()}
MIME-Version: 1.0
Content-Language: en-US
To: ${t.context.alias.name}@${t.context.domain.name}
From: ${t.context.alias.name}@${t.context.domain.name}
Subject: unseen-test-${i}
Content-Type: text/plain; charset=UTF-8; format=flowed
Content-Transfer-Encoding: 7bit

test
`.trim();

    // eslint-disable-next-line no-await-in-loop
    await t.context.imapFlow.append('yoyo', Buffer.from(raw), [], new Date());
  }

  for (let i = 0; i < 10; i++) {
    const raw = `
Date: ${new Date().toISOString()}
MIME-Version: 1.0
Content-Language: en-US
To: ${t.context.alias.name}@${t.context.domain.name}
From: ${t.context.alias.name}@${t.context.domain.name}
Subject: seen-test-${i}
Content-Type: text/plain; charset=UTF-8; format=flowed
Content-Transfer-Encoding: 7bit

test
`.trim();

    // eslint-disable-next-line no-await-in-loop
    await t.context.imapFlow.append(
      'yoyo',
      Buffer.from(raw),
      ['\\Seen'],
      new Date()
    );
  }

  await t.context.imapFlow.mailboxOpen('yoyo');
  const status = await t.context.imapFlow.status('yoyo', {
    messages: true,
    unseen: true
  });
  t.log('status', status);
  t.is(status.path, 'yoyo');
  t.is(status.messages, 20);
  t.is(status.unseen, 10);
});

test('message flags set', async (t) => {
  await t.context.imapFlow.mailboxCreate('flag-set');

  const raw = `
Content-Type: multipart/mixed; boundary="------------cWFvDSey27tFG0hVYLqp9hs9"
MIME-Version: 1.0
To: ${t.context.alias.name}@${t.context.domain.name}
From: ${t.context.alias.name}@${t.context.domain.name}
Subject: test

This is a multi-part message in MIME format.
--------------cWFvDSey27tFG0hVYLqp9hs9
Content-Type: text/plain; charset=UTF-8; format=flowed
Content-Transfer-Encoding: 7bit

test

--------------cWFvDSey27tFG0hVYLqp9hs9
Content-Type: text/plain; charset=UTF-8; name="example.txt"
Content-Disposition: attachment; filename="example.txt"
Content-Transfer-Encoding: base64

ZXhhbXBsZQo=

--------------cWFvDSey27tFG0hVYLqp9hs9--`.trim();

  await t.context.imapFlow.append(
    'flag-set',
    Buffer.from(raw),
    ['\\Seen', '\\Flagged', '\\Draft'],
    new Date()
  );

  await t.context.imapFlow.mailboxOpen('flag-set');

  t.true(
    await t.context.imapFlow.messageFlagsSet({ all: true }, ['\\Deleted'])
  );

  const mailbox = await Mailboxes.findOne(t.context.imap, t.context.session, {
    path: 'flag-set'
  });

  t.is(mailbox.path, 'flag-set');

  const message = await Messages.findOne(t.context.imap, t.context.session, {
    mailbox: mailbox._id
  });

  t.deepEqual(message.flags, ['\\Deleted']);
});

test('message flags remove', async (t) => {
  await t.context.imapFlow.mailboxCreate('flag-remove');

  const raw = `
Content-Type: multipart/mixed; boundary="------------cWFvDSey27tFG0hVYLqp9hs9"
MIME-Version: 1.0
To: ${t.context.alias.name}@${t.context.domain.name}
From: ${t.context.alias.name}@${t.context.domain.name}
Subject: test

This is a multi-part message in MIME format.
--------------cWFvDSey27tFG0hVYLqp9hs9
Content-Type: text/plain; charset=UTF-8; format=flowed
Content-Transfer-Encoding: 7bit

test

--------------cWFvDSey27tFG0hVYLqp9hs9
Content-Type: text/plain; charset=UTF-8; name="example.txt"
Content-Disposition: attachment; filename="example.txt"
Content-Transfer-Encoding: base64

ZXhhbXBsZQo=

--------------cWFvDSey27tFG0hVYLqp9hs9--`.trim();

  await t.context.imapFlow.append(
    'flag-remove',
    Buffer.from(raw),
    ['\\Seen', '\\Flagged', '\\Draft'],
    new Date()
  );

  await t.context.imapFlow.mailboxOpen('flag-remove');

  // download latest to test attachment storage
  const download = await t.context.imapFlow.download('*');
  t.true(_.isObject(download) && !_.isEmpty(download));
  const content = await getStream(download.content);
  t.deepEqual(
    _.compact(splitLines(raw)).join(''),
    _.compact(splitLines(content)).join('')
  );

  t.true(
    await t.context.imapFlow.messageFlagsRemove({ all: true }, ['\\Flagged'])
  );

  const mailbox = await Mailboxes.findOne(t.context.imap, t.context.session, {
    path: 'flag-remove'
  });

  t.is(mailbox.path, 'flag-remove');

  const message = await Messages.findOne(t.context.imap, t.context.session, {
    mailbox: mailbox._id
  });

  t.deepEqual(message.flags, ['\\Seen', '\\Draft']);
});

test('sync', async (t) => {
  await t.context.wsp.request({
    action: 'sync',
    timeout: ms('10s'),
    session: t.context.session
  });
  t.pass();
});

test('temporary storage', async (t) => {
  // add some messages to tmp
  const now = new Date();
  const subject = randomUUID();
  const raw = Buffer.from(
    `
Date: ${now.toISOString()}
MIME-Version: 1.0
Content-Language: en-US
To: foo@foo.com
From: beep@beep.com
Subject: ${subject}
Content-Type: text/plain; charset=UTF-8; format=flowed
Content-Transfer-Encoding: 7bit

test
`.trim()
  );

  const result = await t.context.wsp.request({
    action: 'tmp',
    aliases: [
      {
        address: `${t.context.alias.name}@${t.context.domain.name}`,
        id: t.context.alias.id
      }
    ],
    remoteAddress: IP_ADDRESS,
    date: now.toISOString(),
    raw
  });

  // errors should be empty object
  t.deepEqual(result, {});

  // t.is(result.date, now.toISOString());
  // t.is(result.raw.type, 'Buffer');
  // t.deepEqual(raw, Buffer.from(result.raw.data));
  // t.is(result.remoteAddress, IP_ADDRESS);
  // t.true(typeof result._id === 'string');
  // t.true(typeof result.created_at === 'string');
  // t.true(typeof result.updated_at === 'string');

  // leverage existing connection to fetch
  await t.context.imapFlow.mailboxOpen('INBOX');

  // ensure message stored
  const msg = await Messages.findOne(t.context.imap, t.context.session, {
    subject
  });

  t.true(msg !== null);
  t.is(msg.subject, subject);
});
