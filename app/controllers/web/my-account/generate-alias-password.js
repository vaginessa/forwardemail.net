/**
 * Copyright (c) Forward Email LLC
 * SPDX-License-Identifier: BUSL-1.1
 */

const Boom = require('@hapi/boom');
const _ = require('lodash');
const isSANB = require('is-string-and-not-blank');
const { isEmail } = require('validator');

const Aliases = require('#models/aliases');
const Domains = require('#models/domains');
const config = require('#config');
const createWebSocketAsPromised = require('#helpers/create-websocket-as-promised');
const email = require('#helpers/email');
const i18n = require('#helpers/i18n');
const isValidPassword = require('#helpers/is-valid-password');
const isErrorConstructorName = require('#helpers/is-error-constructor-name');
const { encrypt } = require('#helpers/encrypt-decrypt');

// eslint-disable-next-line complexity
async function generateAliasPassword(ctx) {
  const redirectTo = ctx.state.l(
    `/my-account/domains/${ctx.state.domain.name}/aliases`
  );

  let originalTokens;
  let newToken = false;

  try {
    const alias = await Aliases.findById(ctx.state.alias._id)
      .select('+tokens.hash +tokens.salt')
      .exec();

    originalTokens = alias.tokens;

    if (alias.name === '*')
      throw Boom.badRequest(
        ctx.translateError('CANNOT_CREATE_TOKEN_FOR_CATCHALL')
      );

    if (alias.name.startsWith('/'))
      throw Boom.badRequest(
        ctx.translateError('CANNOT_CREATE_TOKEN_FOR_REGEX')
      );

    // if user did not specify is_override === true and no password provided
    // and the alias had existing passwords then throw an error
    if (
      Array.isArray(alias.tokens) &&
      alias.tokens.length > 0 &&
      !isSANB(ctx.request.body.password) &&
      ctx.request.body.is_override !== 'true'
    )
      throw Boom.badRequest(ctx.translateError('ALIAS_OVERRIDE_REQUIRED'));

    // prompt user for email address to send password to
    let emailedInstructions;
    if (isSANB(ctx.request.body.emailed_instructions)) {
      if (!isEmail(ctx.request.body.emailed_instructions))
        throw Boom.badRequest(ctx.translateError('INVALID_EMAIL'));
      emailedInstructions = ctx.request.body.emailed_instructions.toLowerCase();
    }

    if (isSANB(ctx.request.body.password)) {
      if (ctx.request.body.is_override === 'true')
        throw Boom.badRequest(
          ctx.translateError('ALIAS_OVERRIDE_CANNOT_HAVE_PASSWORD')
        );

      //
      // rate limiting (checks if we have had more than 5 failed auth attempts in a row)
      //
      const count = await ctx.client.incrby(
        `auth_limit_${config.env}:${ctx.state.user.id}`,
        0
      );

      if (count >= config.smtpLimitAuth)
        throw Boom.forbidden(ctx.translateError('ALIAS_RATE_LIMITED'));

      // trim password
      ctx.request.body.password = ctx.request.body.password.trim();

      // ensure that the token is valid
      const isValid = await isValidPassword(
        alias.tokens,
        ctx.request.body.password
      );

      if (!isValid) {
        // increase failed counter by 1
        const key = `auth_limit_${config.env}:${ctx.state.user.id}`;
        await ctx.client
          .pipeline()
          .incr(key)
          .pexpire(key, config.smtpLimitAuthDuration)
          .exec();
        throw Boom.forbidden(ctx.translateError('INVALID_PASSWORD'));
      }

      // Clear authentication limit for this user
      await ctx.client.del(`auth_limit_${config.env}:${ctx.state.user.id}`);
    }

    // set locale for translation in `createToken`
    alias.locale = ctx.locale;
    alias.tokens = [];

    // get user inputs
    const userInputs = [
      alias.name,
      alias.description,
      ...alias.labels,
      ctx.state.domain.name,
      `${alias.name}@${ctx.state.domain.name}`
    ];

    for (const prop of [
      'email',
      config.passport.fields.givenName,
      config.passport.fields.familyName,
      config.userFields.receiptEmail,
      config.userFields.companyName,
      config.userFields.addressLine1,
      config.userFields.addressLine2,
      config.userFields.addressCity,
      config.userFields.addressState,
      config.userFields.addressZip,
      config.userFields.companyVAT
    ]) {
      if (isSANB(ctx.state.user[prop])) userInputs.push(ctx.state.user[prop]);
    }

    const pass = await alias.createToken(
      ctx.state.user.email,
      ctx.request.body.new_password || undefined,
      _.uniq(_.compact(userInputs))
    );
    newToken = true;
    alias.emailed_instructions = emailedInstructions || undefined;

    if (isSANB(ctx.request.body.password)) {
      // change password on existing sqlite file using supplied password and new password
      const wsp = createWebSocketAsPromised();

      await wsp.request({
        action: 'rekey',
        new_password: encrypt(pass),
        session: {
          user: {
            id: alias.id,
            username: `${alias.name}@${ctx.state.domain.name}`,
            alias_id: alias.id,
            alias_name: alias.name,
            domain_id: ctx.state.domain.id,
            domain_name: ctx.state.domain.name,
            password: encrypt(ctx.request.body.password),
            storage_location: alias.storage_location,
            alias_has_pgp: alias.has_pgp,
            alias_public_key: alias.public_key,
            locale: ctx.locale,
            owner_full_email: ctx.state.user[config.userFields.fullEmail]
          }
        }
      });

      // don't save until we're sure that sqlite operations were performed
      await alias.save();

      // close websocket
      try {
        wsp.close();
      } catch (err) {
        ctx.logger.fatal(err);
      }
    } else if (ctx.request.body.is_override === 'true') {
      // reset existing mailbox and create new mailbox
      const wsp = createWebSocketAsPromised();

      // close websocket
      try {
        wsp.close();
      } catch (err) {
        ctx.logger.fatal(err);
      }

      await wsp.request({
        action: 'reset',
        session: {
          user: {
            id: alias.id,
            username: `${alias.name}@${ctx.state.domain.name}`,
            alias_id: alias.id,
            alias_name: alias.name,
            domain_id: ctx.state.domain.id,
            domain_name: ctx.state.domain.name,
            password: encrypt(pass),
            storage_location: alias.storage_location,
            alias_has_pgp: alias.has_pgp,
            alias_public_key: alias.public_key,
            locale: ctx.locale,
            owner_full_email: ctx.state.user[config.userFields.fullEmail]
          }
        }
      });

      // don't save until we're sure that sqlite operations were performed
      await alias.save();

      // close websocket
      try {
        wsp.close();
      } catch (err) {
        ctx.logger.fatal(err);
      }
    } else {
      // save alias
      await alias.save();
      // create new mailbox
      const wsp = createWebSocketAsPromised();
      await wsp.request({
        action: 'setup',
        session: {
          user: {
            id: alias.id,
            username: `${alias.name}@${ctx.state.domain.name}`,
            alias_id: alias.id,
            alias_name: alias.name,
            domain_id: ctx.state.domain.id,
            domain_name: ctx.state.domain.name,
            password: encrypt(pass),
            storage_location: alias.storage_location,
            alias_has_pgp: alias.has_pgp,
            alias_public_key: alias.public_key,
            locale: ctx.locale,
            owner_full_email: ctx.state.user[config.userFields.fullEmail]
          }
        }
      });

      // close websocket
      try {
        wsp.close();
      } catch (err) {
        ctx.logger.fatal(err);
      }
    }

    const { to, locale } = await Domains.getToAndMajorityLocaleByDomain(
      ctx.state.domain
    );

    // send password instructions to address provided
    if (emailedInstructions) {
      await email({
        template: 'alert',
        message: {
          to: emailedInstructions,
          locale,
          subject: i18n.translate(
            'ALIAS_PASSWORD_INSTRUCTIONS_SUBJECT',
            locale,
            `${alias.name}@${ctx.state.domain.name}`
          )
        },
        locals: {
          locale,
          message: i18n.translate(
            'ALIAS_PASSWORD_EMAIL',
            locale,
            ctx.state.user.email,
            `${alias.name}@${ctx.state.domain.name}`,
            //
            // NOTE: if this URL is retrieved and valid then a new password is generated and rendered for 30s
            //       (and can only be accessed if the alias has `emailed_instructions` equal to the entered value
            //
            `${config.urls.web}/ap/${ctx.state.domain.id}/${alias.id}/${encrypt(
              pass
            )}`
          )
        }
      });
    }

    // send email notification when new password generated
    email({
      template: 'alert',
      message: {
        to,
        ...(to.includes(ctx.state.user.email)
          ? {}
          : { cc: ctx.state.user[config.userFields.fullEmail] }),
        subject: i18n.translate(
          'ALIAS_PASSWORD_GENERATED_SUBJECT',
          locale,
          `${alias.name}@${ctx.state.domain.name}`
        )
      },
      locals: {
        user: ctx.state.user,
        locale,
        message: (
          i18n.translate(
            'ALIAS_PASSWORD_GENERATED',
            locale,
            `${alias.name}@${ctx.state.domain.name}`,
            ctx.state.user.email
          ) +
          ' ' +
          (emailedInstructions
            ? i18n.translate(
                'ALIAS_PASSWORD_INSTRUCTIONS',
                locale,
                emailedInstructions
              )
            : '')
        ).trim()
      }
    })
      .then()
      .catch((err) => ctx.logger.fatal(err));

    const html = emailedInstructions
      ? ctx.translate('ALIAS_PASSWORD_INSTRUCTIONS', emailedInstructions)
      : ctx.translate(
          'ALIAS_GENERATED_PASSWORD',
          `${alias.name}@${ctx.state.domain.name}`,
          pass
        );

    const swal = {
      title: ctx.request.t('Success'),
      html,
      type: 'success',
      ...(emailedInstructions
        ? {}
        : {
            timer: 30000,
            position: 'top',
            allowEscapeKey: false,
            allowOutsideClick: false,
            focusConfirm: false,
            grow: 'fullscreen',
            backdrop: 'rgba(0,0,0,0.8)',
            customClass: {
              container: 'swal2-grow-fullscreen'
            }
          })
    };
    ctx.flash('custom', swal);
    if (ctx.accepts('html')) {
      ctx.redirect(redirectTo);
    } else {
      ctx.body = { redirectTo };
    }
  } catch (err) {
    //
    // if an error occurs then remove any tokens created (if any)
    // and restore the original tokens that were there (if any)
    // (this edge case happens if `wsp.request` cannot connect or set new key)
    //
    if (newToken && Array.isArray(originalTokens)) {
      // restore original tokens
      try {
        await Aliases.findByIdAndUpdate(ctx.state.alias._id, {
          $set: {
            tokens: originalTokens
          }
        });
      } catch (err) {
        ctx.logger.fatal(err);
      }
    }

    if (err && err.isBoom) throw err;
    if (isErrorConstructorName(err, 'ValidationError')) throw err;
    ctx.logger.fatal(err);
    ctx.flash('error', ctx.translate('UNKNOWN_ERROR'));
    const redirectTo = ctx.state.l(
      `/my-account/domains/${ctx.state.domain.name}/aliases`
    );
    if (ctx.accepts('html')) ctx.redirect(redirectTo);
    else ctx.body = { redirectTo };
  }
}

module.exports = generateAliasPassword;
