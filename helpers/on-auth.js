/**
 * Copyright (c) Forward Email LLC
 * SPDX-License-Identifier: BUSL-1.1
 */

const punycode = require('node:punycode');

const POP3Server = require('wildduck/lib/pop3/server');
const isSANB = require('is-string-and-not-blank');
const ms = require('ms');
const pify = require('pify');
const { IMAPServer } = require('wildduck/imap-core');
const { isEmail } = require('validator');

const SMTPError = require('./smtp-error');
const ServerShutdownError = require('./server-shutdown-error');
const SocketError = require('./socket-error');
const parseRootDomain = require('./parse-root-domain');
const refineAndLogError = require('./refine-and-log-error');
const validateAlias = require('./validate-alias');
const validateDomain = require('./validate-domain');

const Aliases = require('#models/aliases');
const Domains = require('#models/domains');
const config = require('#config');
const env = require('#config/env');
const getQueryResponse = require('#helpers/get-query-response');
const i18n = require('#helpers/i18n');
const isValidPassword = require('#helpers/is-valid-password');
const onConnect = require('#helpers/smtp/on-connect');
const { encrypt } = require('#helpers/encrypt-decrypt');

const onConnectPromise = pify(onConnect);

// eslint-disable-next-line complexity
async function onAuth(auth, session, fn) {
  this.logger.debug('AUTH', { auth, session });

  // TODO: credit system + domain billing rules (assigned billing manager -> person who gets credits deducted)
  // TODO: salt/hash/deprecate legacy API token + remove from API docs page
  // TODO: replace usage of config.recordPrefix with config.paidPrefix and config.freePrefix

  try {
    //
    // NOTE: until onConnect is available for IMAP and POP3 servers
    //       we leverage the existing SMTP helper in the interim
    //       <https://github.com/nodemailer/wildduck/issues/540>
    //
    if (this.server instanceof IMAPServer || this.server instanceof POP3Server)
      await onConnectPromise.call(this, session);

    // check if server is in the process of shutting down
    if (this.server._closeTimeout) throw new ServerShutdownError();

    // NOTE: WildDuck POP3 server uses naming of `_closingTimeout` instead of `_closeTimeout`
    if (this.server._closingTimeout) throw new ServerShutdownError();

    // NOTE: socket is not yet exposed in WildDuck POP3 server in session object
    // check if socket is still connected (only applicable for IMAP and POP3 servers)
    if (this.server instanceof IMAPServer) {
      const socket =
        (session.socket && session.socket._parent) || session.socket;
      if (!socket || socket?.destroyed || socket?.readyState !== 'open')
        throw new SocketError();
    }

    // override session.getQueryResponse (safeguard)
    session.getQueryResponse = getQueryResponse;

    // username must be a valid email address
    if (
      typeof auth.username !== 'string' ||
      !isSANB(auth.username) ||
      !isEmail(auth.username.trim()) ||
      // <https://react.email/docs/integrations/nodemailer>
      auth.username === 'my_user' ||
      // <https://nodemailer.com/about/#example>
      auth.username === 'REPLACE-WITH-YOUR-ALIAS@YOURDOMAIN.COM'
    )
      throw new SMTPError(
        `Invalid username, please enter a valid email address (e.g. "alias@example.com"); use one of your domain's aliases at ${config.urls.web}/my-account/domains`,
        {
          responseCode: 535,
          ignoreHook: true
        }
      );

    let [name, domainName] = auth.username.trim().toLowerCase().split('@');

    domainName = punycode.toUnicode(domainName);

    // password must be a 24 character long generated string
    if (
      typeof auth.password !== 'string' ||
      !isSANB(auth.password) ||
      auth.password.length > 128 ||
      // <https://react.email/docs/integrations/nodemailer>
      auth.password === 'my_password' ||
      // <https://nodemailer.com/about/#example>
      auth.password === 'REPLACE-WITH-YOUR-GENERATED-PASSWORD'
    )
      throw new SMTPError(
        `Invalid password, please try again or go to ${config.urls.web}/my-account/domains/${domainName}/aliases and click "Generate Password"`,
        {
          responseCode: 535,
          ignoreHook: true
        }
      );

    // trim password in-memory
    auth.password = auth.password.trim();

    const verifications = [];
    try {
      const records = await this.resolver.resolveTxt(domainName);
      for (const record_ of records) {
        const record = record_.join('').trim(); // join chunks together
        if (record.startsWith(config.paidPrefix))
          verifications.push(record.replace(config.paidPrefix, '').trim());
      }
    } catch (err) {
      this.logger.error(err, { session });
    }

    if (verifications.length === 0)
      throw new SMTPError(
        `Domain is missing TXT verification record, go to ${config.urls.web}/my-account/domains/${domainName} and click "Verify"`,
        {
          responseCode: 535,
          ignoreHook: true
        }
      );

    if (verifications.length > 1)
      throw new SMTPError(
        `Domain has more than one TXT verification record, go to ${config.urls.web}/my-account/domains/${domainName} and click "Verify"`,
        {
          responseCode: 535,
          ignoreHook: true
        }
      );

    const domain = await Domains.findOne({
      name: domainName,
      verification_record: verifications[0],
      plan: { $ne: 'free' }
    })
      .populate(
        'members.user',
        `id group plan ${config.userFields.isBanned} ${config.userFields.hasVerifiedEmail} ${config.userFields.planExpiresAt} ${config.userFields.stripeSubscriptionID} ${config.userFields.paypalSubscriptionID}`
      )
      .select('+tokens.hash +tokens.salt')
      .lean()
      .exec();

    // validate domain
    validateDomain(domain, domainName);

    let alias;
    if (name !== '*')
      alias = await Aliases.findOne({
        name,
        domain: domain._id
      })
        .populate(
          'user',
          `id ${config.userFields.isBanned} ${config.userFields.smtpLimit} ${config.userFields.fullEmail} ${config.lastLocaleField}`
        )
        .select('+tokens.hash +tokens.salt')
        .lean()
        .exec();

    // validate alias (will throw an error if !alias)
    if (
      alias ||
      this.server instanceof IMAPServer ||
      this.server instanceof POP3Server
    )
      validateAlias(alias, domain, name);

    //
    // validate the `auth.password` provided
    //

    // IMAP and POP3 servers can only validate against aliases
    if (
      this.server instanceof IMAPServer ||
      this.server instanceof POP3Server
    ) {
      if (!Array.isArray(alias.tokens) || alias?.tokens?.length === 0)
        throw new SMTPError(
          `Alias does not have a generated password yet, go to ${config.urls.web}/my-account/domains/${domain.name}/aliases and click "Generate Password"`,
          {
            responseCode: 535,
            ignoreHook: true
          }
        );
    } else if (
      alias &&
      ((!Array.isArray(alias.tokens) && !Array.isArray(domain.tokens)) ||
        (alias?.tokens?.length === 0 && domain?.tokens?.length === 0))
    )
      // SMTP servers can validate against both alias and domain-wide tokens
      throw new SMTPError(
        `Alias does not have a generated password yet, go to ${config.urls.web}/my-account/domains/${domain.name}/aliases and click "Generate Password"`,
        {
          responseCode: 535,
          ignoreHook: true
        }
      );

    //
    // rate limiting (checks if we have had more than 5 failed auth attempts in a row)
    //
    if (
      // do not rate limit IP addresses corresponding to our servers
      !session.resolvedClientHostname ||
      parseRootDomain(session.resolvedClientHostname) !== env.WEB_HOST
    ) {
      const count = await this.client.incrby(
        `auth_limit_${config.env}:${session.remoteAddress}`,
        0
      );
      if (count >= config.smtpLimitAuth) {
        // alert admins of failed login by IP address
        // (until this gets out of hand)
        if (session.resolvedClientHostname) {
          this.logger.error(
            new TypeError(
              `${session.resolvedClientHostname} (${parseRootDomain(
                session.resolvedClientHostname
              )}) has exceeded failed login attempts`
            )
          );
        } else {
          this.logger.error(
            new TypeError(
              `${session.remoteAddress} has exceeded failed login attempts`
            )
          );
        }

        throw new SMTPError(
          `You have exceeded the maximum number of failed authentication attempts. Please try again later or contact us at ${config.supportEmail}`
          // { ignoreHook: true }
        );
      }
    }

    // ensure that the token is valid
    let isValid = false;
    if (alias && Array.isArray(alias.tokens) && alias.tokens.length > 0)
      isValid = await isValidPassword(alias.tokens, auth.password);

    //
    // NOTE: this is only applicable to SMTP servers (outbound mail)
    //       we allow users to use a generated token for the domain
    //
    if (
      !(this.server instanceof IMAPServer) &&
      !(this.server instanceof POP3Server) &&
      !isValid &&
      Array.isArray(domain.tokens) &&
      domain.tokens.length > 0
    )
      isValid = await isValidPassword(domain.tokens, auth.password);

    if (!isValid) {
      // increase failed counter by 1
      const key = `auth_limit_${config.env}:${session.remoteAddress}`;
      await this.client
        .pipeline()
        .incrby(key, 1)
        .pexpire(key, config.smtpLimitAuthDuration)
        .exec();
      throw new SMTPError(
        `Invalid password, please try again or go to ${config.urls.web}/my-account/domains/${domainName}/aliases and click "Generate Password"`,
        {
          responseCode: 535
          // ignoreHook: true
        }
      );
    }

    // Clear authentication limit for this IP address
    await this.client.del(`auth_limit_${config.env}:${session.remoteAddress}`);

    // if any of the domain admins are admins then don't rate limit concurrent connections
    const adminExists = domain.members.some((m) => {
      return m.group === 'admin' && m?.user?.group === 'admin';
    });

    // ensure we don't have more than 30 connections per alias
    // (or per domain if we're using a catch-all)
    const key = `connections_${config.env}:${alias ? alias.id : domain.id}`;
    const count = await this.client.incrby(key, 0);
    if (count < 0) await this.client.del(key); // safeguard
    else if (!adminExists && count > 30) {
      // early monitoring for admins (probably remove this later once it becomes a burden)
      const err = new TypeError(
        `Too many concurrent connections from ${
          alias ? `${alias.name}@${domain.name}` : domain.name
        } with key "${key}"`
      );
      this.logger.error(err, { session });
      throw new SMTPError('Too many concurrent connections', {
        responseCode: 421
      });
    }

    // increase counter for alias by 1 (with ttl safeguard)
    await this.client.pipeline().incr(key).pexpire(key, ms('1h')).exec();

    const to = [];

    // this also ensures that at least one admin has a verified email address
    const obj = await Domains.getToAndMajorityLocaleByDomain(domain);

    // set default locale for translation for the session
    let locale = i18n.config.defaultLocale;
    locale =
      alias && alias.user[config.lastLocaleField]
        ? alias.user[config.lastLocaleField]
        : obj.locale;

    if (alias && alias.user[config.userFields.fullEmail]) {
      to.push(alias.user[config.userFields.fullEmail]);
    } else {
      to.push(...obj.to);
    }

    // prepare user object for `session.user`
    // <https://github.com/nodemailer/wildduck/issues/510>
    const user = {
      // support domain-wide catch-all by conditionally checking `alias` below:
      id: alias ? alias.id : domain.id,
      username: alias
        ? `${alias.name}@${domain.name}`
        : auth.username.trim().toLowerCase(),
      ...(alias
        ? {
            alias_id: alias.id,
            alias_name: alias.name,
            storage_location: alias.storage_location
          }
        : {}),
      domain_id: domain.id,
      domain_name: domain.name,
      // safeguard to encrypt in-memory
      password: encrypt(auth.password),
      //
      // NOTE: if `has_pgp` or `public_key` gets updated then
      //       they will be refreshed automatically via websockets
      //       (see update alias controller)
      //
      // NOTE: these fields will refresh in `refreshSession` helper
      //
      // pgp support
      ...(alias && alias.has_pgp && alias.public_key
        ? {
            alias_has_pgp: alias.has_pgp,
            alias_public_key: alias.public_key
          }
        : {}),
      // NOTE: this field will refresh in `refreshSession` helper
      locale,
      // NOTE: this field will refresh in `refreshSession` helper
      owner_full_email: to
    };

    //
    // sync with tmp db in the background
    // (will cause imap-notifier to send IDLE notifications)
    //
    if (
      this.wsp &&
      (this.server instanceof IMAPServer || this.server instanceof POP3Server)
    ) {
      this.wsp
        .request({
          action: 'sync',
          timeout: ms('5m'),
          session: { user }
        })
        .then()
        .catch((err) => this.logger.fatal(err, { user }));
    }

    // this response object sets `session.user` to have `domain` and `alias`
    // <https://github.com/nodemailer/smtp-server/blob/a570d0164e4b4ef463eeedd80cadb37d5280e9da/lib/sasl.js#L235>
    fn(null, { user });
  } catch (err) {
    //
    // NOTE: we should actually share error message if it was not a code bug
    //       (otherwise it won't be intuitive to users if they're late on payment)
    //
    // <https://github.com/nodemailer/smtp-server/blob/a570d0164e4b4ef463eeedd80cadb37d5280e9da/lib/sasl.js#L189-L222>
    fn(refineAndLogError(err, session, this.server instanceof IMAPServer));
  }
}

module.exports = onAuth;
