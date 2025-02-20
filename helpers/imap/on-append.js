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

const bytes = require('bytes');
const dayjs = require('dayjs-with-plugins');
const mongoose = require('mongoose');
const ms = require('ms');
const parseErr = require('parse-err');
const splitLines = require('split-lines');
const { IMAPConnection } = require('wildduck/imap-core/lib/imap-connection');
const { convert } = require('html-to-text');

const email = require('../email');
const isCodeBug = require('../is-code-bug');

const Aliases = require('#models/aliases');
const IMAPError = require('#helpers/imap-error');
const Mailboxes = require('#models/mailboxes');
const Messages = require('#models/messages');
const Threads = require('#models/threads');
const config = require('#config');
const encryptMessage = require('#helpers/encrypt-message');
const getFingerprint = require('#helpers/get-fingerprint');
const i18n = require('#helpers/i18n');
const refineAndLogError = require('#helpers/refine-and-log-error');

const { formatResponse } = IMAPConnection.prototype;

const SIXTY_FOUR_MB_IN_BYTES = bytes('64MB');

// eslint-disable-next-line max-params, complexity
async function onAppend(path, flags, date, raw, session, fn) {
  this.logger.debug('APPEND', { path, flags, date, session });

  let thread;
  let hasNodeBodies;
  let maildata;
  let mimeTreeData;

  try {
    // do not allow messages larger than 64 MB
    if (
      raw &&
      (Buffer.isBuffer(raw) ? Buffer.byteLength(raw) : raw.length) >
        SIXTY_FOUR_MB_IN_BYTES
    )
      throw new IMAPError(
        i18n.translate('IMAP_MESSAGE_SIZE_EXCEEDED', session.user.locale)
      );

    if (this?.constructor?.name === 'IMAP') {
      try {
        const [bool, response, writeStream] = await this.wsp.request({
          action: 'append',
          session: {
            id: session.id,
            user: session.user,
            remoteAddress: session.remoteAddress
          },
          path,
          flags,
          date,
          raw
        });

        if (Array.isArray(writeStream)) {
          for (const write of writeStream) {
            if (Array.isArray(write)) {
              session.writeStream.write(session.formatResponse(...write));
            } else {
              session.writeStream.write(write);
            }
          }
        }

        fn(null, bool, response);
      } catch (err) {
        fn(err);
      }

      return;
    }

    await this.refreshSession(session, 'APPEND');

    const writeStream = [];

    // check if over quota
    const { storageUsed, isOverQuota } = await Aliases.isOverQuota({
      id: session.user.alias_id,
      domain: session.user.domain_id,
      locale: session.user.locale
    });
    if (isOverQuota)
      throw new IMAPError(
        i18n.translate('IMAP_MAILBOX_OVER_QUOTA', session.user.locale),
        {
          imapResponse: 'OVERQUOTA'
        }
      );

    // <https://github.com/nodemailer/wildduck/blob/b9349f6e8315873668d605e6567ced2d7b1c0c80/lib/handlers/on-append.js#L65>
    let mailbox = await Mailboxes.findOne(this, session, {
      path
    });

    //
    // <https://www.rfc-editor.org/rfc/rfc3502.html#section-6.3.11>
    //
    // > If the destination mailbox does not exist, a server MUST return an
    //   error, and MUST NOT automatically create the mailbox.  Unless it
    //   is certain that the destination mailbox can not be created, the
    //   server MUST send the response code "[TRYCREATE]" as the prefix of
    //   the text of the tagged NO response.  This gives a hint to the
    //   client that it can attempt a CREATE command and retry the APPEND
    //   if the CREATE is successful.
    //
    if (!mailbox)
      throw new IMAPError(
        i18n.translate('IMAP_MAILBOX_DOES_NOT_EXIST', session.user.locale),
        {
          imapResponse: 'TRYCREATE'
        }
      );

    // encrypt message if it is not a Draft and user has a public key
    if (
      !flags.includes('\\Draft') && //
      session.user.alias_has_pgp &&
      session.user.alias_public_key
    ) {
      try {
        // NOTE: encryptMessage won't encrypt message if it already is
        raw = await encryptMessage(session.user.alias_public_key, raw);
        // unset pgp_error_sent_at if it was a date and more than 1h ago
        Aliases.findOneAndUpdate(
          {
            _id: new mongoose.Types.ObjectId(session.user.alias_id),
            domain: new mongoose.Types.ObjectId(session.user.domain_id),
            pgp_error_sent_at: {
              $exists: true,
              $lte: dayjs().subtract(1, 'hour').toDate()
            }
          },
          {
            $unset: {
              pgp_error_sent_at: 1
            }
          }
        )
          .then()
          .catch((err) =>
            this.logger.fatal(err, { path, flags, date, session })
          );
      } catch (err) {
        this.logger.fatal(err, { path, flags, date, session });
        if (!isCodeBug(err)) {
          // email alias user (only once a day as a reminder) if it was not a code bug
          const now = new Date();
          Aliases.findOneAndUpdate(
            {
              $and: [
                {
                  _id: new mongoose.Types.ObjectId(session.user.alias_id),
                  domain: new mongoose.Types.ObjectId(session.user.domain_id)
                },
                {
                  $or: [
                    {
                      pgp_error_sent_at: {
                        $exists: false
                      }
                    },
                    {
                      pgp_error_sent_at: {
                        $lte: dayjs().subtract(1, 'day').toDate()
                      }
                    }
                  ]
                }
              ]
            },
            {
              $set: {
                pgp_error_sent_at: now
              }
            }
          )
            .then((alias) => {
              if (!alias) return;
              // send email here and if error occurred then unset
              email({
                template: 'alert',
                message: {
                  to: session.user.owner_full_email,
                  cc: config.email.message.from,
                  subject: i18n.translate(
                    'PGP_ENCRYPTION_ERROR',
                    session.user.locale
                  )
                },
                locals: {
                  message: `<pre><code>${JSON.stringify(
                    parseErr(err),
                    null,
                    2
                  )}</code></pre>`,
                  locale: session.user.locale
                }
              })
                .then(() => {
                  Aliases.findOneAndUpdate(alias._id, {
                    $set: {
                      pgp_error_sent_at: new Date()
                    }
                  })
                    .then()
                    .catch((err) =>
                      this.logger.fatal(err, { path, flags, date, session })
                    );
                })
                .catch((err) => {
                  this.logger.fatal(err, { path, flags, date, session });
                  Aliases.findOneAndUpdate(
                    {
                      _id: new mongoose.Types.ObjectId(session.user.alias_id),
                      domain: new mongoose.Types.ObjectId(
                        session.user.domain_id
                      ),
                      pgp_error_sent_at: now
                    },
                    {
                      $unset: {
                        pgp_error_sent_at: 1
                      }
                    }
                  ).catch((err) =>
                    this.logger.fatal(err, { path, flags, date, session })
                  );
                });
            })
            .catch((err) =>
              this.logger.fatal(err, { path, flags, date, session })
            );
        }
      }
    }

    const {
      id,
      mimeTree,
      size,
      bodystructure,
      envelope,
      idate,
      hdate,
      msgid,
      subject,
      headers
    } = await this.prepareMessage({
      flags,
      date,
      raw
    });

    //
    // NOTE: this prevents storing duplicate messages
    //
    // (e.g. in case MX server attempts multiple delivery attempts)
    // (and in this case we simply return the already existing message)
    // <https://github.com/nodemailer/wildduck/issues/555>
    //
    //
    // NOTE: this assumes that if a message was received
    //       and it's not in the INBOX, then the user moved it
    //       and so we shouldn't store a duplicate copy
    //

    //
    // NOTE: we pass `false` as an argument here because a sender could
    //       try to send a message from multiple different SMTP providers
    //       (e.g. or in the case they need to do damage control, they would send via another provider)
    //       (and so for ones that went through, we don't want to store them twice)
    //       (note that this is unlike the MX server, which has this set to `true`)
    //
    const fingerprint = getFingerprint(session, headers, mimeTree.body, false);

    const existingMessage = await Messages.findOne(this, session, {
      fingerprint
    });

    //
    // this typically only happens if we're sending from MX server
    // (sometimes senders will make multiple attempts even if one succeeded)
    //
    if (existingMessage) {
      const response = {
        uidValidity: mailbox.uidValidity,
        uid: existingMessage.uid,
        id: existingMessage.id,
        mailbox: mailbox._id,
        mailboxPath: mailbox.path,
        size: existingMessage.size,
        status: 'new' // TODO: should this be "existing"
      };
      this.logger.debug('command response', { response });
      fn(null, true, response, writeStream);
      return;
    }

    // store reference for cleanup
    mimeTreeData = mimeTree;

    const exceedsQuota = storageUsed + size > config.maxQuotaPerAlias;
    if (exceedsQuota)
      throw new IMAPError(
        i18n.translate(
          'IMAP_MAILBOX_MESSAGE_EXCEEDS_QUOTA',
          session.user.locale,
          session.user.username
        ),
        {
          imapResponse: 'OVERQUOTA'
        }
      );

    maildata = this.indexer.getMaildata(mimeTree);

    // store node bodies
    hasNodeBodies = await this.indexer.storeNodeBodies(
      this,
      session,
      maildata,
      mimeTree
    );

    // TODO: we should instead tokenize this with spamscanner
    // if (maildata.text) {
    //   data.text = splitLines(maildata.text).join('\n');
    //   // if text is longer than max permitted then trim it
    //   if (data.text.length > config.maxPlaintextIndexed)
    //     data.text = data.text.slice(0, Math.max(0, config.maxPlaintextIndexed));
    // }
    // prepare text for indexing
    let text = '';
    if (maildata.text) {
      // replace line breaks for consistency
      text = splitLines(maildata.text).join(' ').trim();
      // convert and remove unnecessary things
      text = convert(text, {
        wordwrap: false,
        selectors: [
          { selector: 'img', format: 'skip' },
          { selector: 'ul', options: { itemPrefix: ' ' } },
          {
            selector: 'a',
            options: { linkBrackets: false }
          }
        ]
      });
      // slice if it's too long
      if (text.length > 1024) text = text.slice(0, 1024);
      // trim it up
      text = text.trim();
    }

    //
    // prepare message for creation
    //
    const retention =
      typeof mailbox.retention === 'number' ? mailbox.retention : 0;
    const data = {
      fingerprint,
      mailbox: mailbox._id,
      _id: id,
      root: id,
      exp: retention !== 0,
      rdate: new Date(Date.now() + retention),
      idate,
      hdate,
      flags,
      size,
      headers,
      mimeTree,
      envelope,
      bodystructure,
      msgid,
      unseen: !flags.includes('\\Seen'),
      flagged: flags.includes('\\Flagged'),
      undeleted: !flags.includes('\\Deleted'),
      draft: flags.includes('\\Draft'),
      magic: maildata.magic,
      subject,
      copied: false,
      remoteAddress: session.remoteAddress,
      transaction: 'APPEND',
      // raw,
      text
    };

    if (maildata.attachments && maildata.attachments.length > 0)
      data.attachments = maildata.attachments;

    //
    // TODO: explore modseq usage (for journal sorting by modseq uids in ascending order)
    //

    // get new uid and modsec and return original values
    mailbox = await Mailboxes.findByIdAndUpdate(
      this,
      session,
      mailbox._id,
      {
        $inc: {
          uidNext: 1,
          modifyIndex: 1
        }
      },
      {
        returnDocument: 'before'
      }
    );

    if (!mailbox)
      throw new IMAPError(
        i18n.translate('IMAP_MAILBOX_DOES_NOT_EXIST', session.user.locale),
        {
          imapResponse: 'TRYCREATE'
        }
      );

    // update message object with mailbox values
    data.uid = mailbox.uidNext;
    data.modseq = mailbox.modifyIndex + 1;

    // store whether searchable or not
    // <https://github.com/nodemailer/wildduck/issues/514>
    data.searchable = !flags.includes('\\Deleted');

    // TODO: notify wildduck about this in GH issues
    // if appending to draft then add draft flag
    if (mailbox.specialUse === '\\Drafts') data.flags.push('\\Draft');

    // store whether junk or not
    data.junk = mailbox.specialUse === '\\Junk';

    // get thread ID
    thread = await Threads.getThreadId(this, session, subject, mimeTree);

    data.thread = thread._id;

    // virtual helper for locking if we lock in advance
    // data.lock = lock;

    // db virtual helper
    data.instance = this;
    data.session = session;

    // store the message
    const message = await Messages.create(data);

    this.logger.debug('message created', {
      message,
      path,
      flags,
      date,
      session
    });

    // update storage
    try {
      const size = await this.wsp.request({
        action: 'size',
        timeout: ms('5s'),
        alias_id: session.user.alias_id
      });
      this.logger.debug('size updated', size);
    } catch (err) {
      this.logger.fatal(err);
    }

    let ignore = false;
    if (
      session.selected &&
      session.selected.mailbox &&
      session.selected.mailbox.toString() === mailbox._id.toString()
    ) {
      ignore = session.id;
      const payload = formatResponse.call(session, 'EXISTS', message.uid);
      if (this?.constructor?.name === 'IMAP') {
        session.writeStream.write(payload);
      } else {
        writeStream.push(payload);
      }
    }

    try {
      await this.server.notifier.addEntries(this, session, mailbox, {
        ignore,
        command: 'EXISTS',
        uid: message.uid,
        mailbox: mailbox._id,
        message: message._id,
        thread: message.thread,
        modseq: message.modseq,
        unseen: message.unseen,
        idate: message.idate,
        junk: message.junk
      });
      this.server.notifier.fire(session.user.alias_id);
    } catch (err) {
      this.logger.fatal(err, { path, flags, date, session });
    }

    const response = {
      uidValidity: mailbox.uidValidity,
      uid: message.uid,
      id,
      mailbox: mailbox._id,
      size,
      status: 'new'
    };

    this.logger.debug('command response', { response });

    fn(null, true, response, writeStream);
  } catch (err) {
    // delete attachments if we need to cleanup
    const attachmentIds =
      hasNodeBodies && mimeTreeData?.attachmentMap
        ? Object.keys(mimeTreeData.attachmentMap || {}).map(
            (key) => mimeTreeData.attachmentMap[key]
          )
        : [];

    if (attachmentIds.length > 0) {
      if (session.db) {
        try {
          await this.attachmentStorage.deleteMany(
            this,
            session,
            attachmentIds,
            maildata.magic
          );
        } catch (err) {
          this.logger.fatal(err, {
            attachmentIds,
            session
          });
        }
      } else {
        this.logger.fatal(
          new TypeError('Attachment storage needs to cleanup'),
          { attachmentIds, session }
        );
      }
    }

    // handle mongodb error
    if (err.code === 1100) err.imapResponse = 'ALREADYEXISTS';

    // NOTE: wildduck uses `imapResponse` so we are keeping it consistent
    if (err.imapResponse) {
      this.logger.error(err, { path, flags, date, session });
      return fn(null, err.imapResponse);
    }

    fn(refineAndLogError(err, session, true));
  }
}

module.exports = onAppend;
