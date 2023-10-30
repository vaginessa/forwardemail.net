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

const mongoose = require('mongoose');
const mongooseCommonPlugin = require('mongoose-common-plugin');

const Mailboxes = require('./mailboxes');
const Messages = require('./messages');
const Threads = require('./threads');

// <https://github.com/Automattic/mongoose/issues/5534>
mongoose.Error.messages = require('@ladjs/mongoose-error-messages');

const Journals = new mongoose.Schema(
  {
    mailbox: {
      type: mongoose.Schema.ObjectId,
      ref: Mailboxes,
      required: true,
      index: true
    },
    message: {
      type: mongoose.Schema.ObjectId,
      ref: Messages
    },
    thread: {
      type: mongoose.Schema.ObjectId,
      ref: Threads
    },
    path: {
      type: String
    },
    uid: {
      type: Number
    },
    created: {
      type: Date
    },
    modseq: {
      type: Number
    },
    command: {
      type: String,
      trim: true,
      uppercase: true
    },
    // session ID to ignore from notifier if any
    ignore: {
      type: String
    },
    unseen: {
      type: Boolean
    },
    idate: {
      type: Date
    },
    junk: {
      type: Boolean
    }
  },
  {
    writeConcern: {
      w: 'majority'
    }
  }
);

Journals.plugin(mongooseCommonPlugin, {
  object: 'journal',
  locale: false
});

const conn = mongoose.connections.find(
  (conn) => conn[Symbol.for('connection.name')] === 'JOURNALS_MONGO_URI'
);
module.exports = conn.model('Journals', Journals);
