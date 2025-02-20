/**
 * Copyright (c) Forward Email LLC
 * SPDX-License-Identifier: BUSL-1.1
 */

// turn off max length eslint rule since this is a config file with long strs
/* eslint max-len: 0 */

// meta tags is an object of paths
// where each path is an array containing
//
// '/some/path': [ title, description ]
//
// note that you can include <span class="notranslate">
// if needed around certain text values in ordre to
// prevent Google Translate from translating them
// note that the helper named `meta` in `helpers/meta.js`
// will automatically remove HTML tags from the strings
// before returning them to be rendered in tags such as
// `<title>` and `<meta name="description">`
//
// const arrayJoinConjunction = require('array-join-conjunction');
const dashify = require('dashify');
const dayjs = require('dayjs-with-plugins');

const {
  developerDocs,
  nsProviders,
  platforms,
  getServersOrClientsList
} = require('#config/utilities');

// eslint-disable-next-line complexity
module.exports = function (config) {
  // in order for snapshots to be consistent we need the same date to be used
  const now =
    config.env === 'test'
      ? dayjs.tz('2023-01-01', 'America/Los_Angeles').toDate()
      : new Date();

  // currently we cannot use the `|` pipe character due to this issue
  // <https://github.com/mashpie/i18n-node/issues/274>
  // otherwise we'd have `| Lad` below, which is SEO standard
  // so instead we need to use `&#124;` which is the html entity
  // which gets decoded to a `|` in the helper.meta function
  const lad = config.metaTitleAffix;
  const meta = {
    // note that we don't do `Home ${lad}` because if we forget to define
    // meta for a specific route it'd be confusing to see Home
    // in the title bar in the user's browser
    '/': [
      'Free Email Forwarding for Custom Domains',
      'Setup encrypted email, free email forwarding, custom domains, private business email, and more with support for outbound SMTP, IMAP, and POP3.'
    ],
    '/about': [
      'Free Email Forwarder for Custom Domains',
      `Learn more about ${config.appName} and the history of our service.`
    ],
    '/private-business-email': [
      'Private Business Email for Custom Domains',
      'Create your free, private, encrypted, and secure email for professional businesses, enterprises, and custom domains.'
    ],
    '/faq': [
      'Frequently Asked Questions About Email',
      'How to configure email for custom domain names, outbound SMTP service, and more.'
    ],
    '/email-api': [
      'Developer Email API for Custom Domains and Webhooks',
      'Developers love our RESTful email forwarding API for custom domains.'
    ],
    '/free-email-webhooks': [
      'Free Email Webhooks for Developers and Custom Domains',
      'Send email with HTTP using our developer webhooks and DNS email forwarding service.'
    ],
    '/email-forwarding-regex-pattern-filter': [
      'Email Forwarding Regular Expression for Custom Domains',
      'Send email with regular expression matching and DNS email forwarding service.'
    ],
    '/terms': [
      'Terms of Service',
      'Read our terms and conditions of use for our email forwarding service.'
    ],
    '/report-abuse': [
      'Report Abuse',
      'Information on how to report abuse for the general public and law enforcement.'
    ],
    '/privacy': [
      'Privacy Policy',
      'Read our privacy policy for our email forwarding service.'
    ],
    '/help': ['Help', 'Ask a question and get support from our team.'],
    '/denylist': [
      'Denylist Removal',
      'Submit your email, domain, or IP address for DNS denylist removal.'
    ],
    '/logout': [`Sign out of ${lad}`, 'Sign out of your account now.'],
    '/register': [
      `Sign up ${lad}`,
      'Get a free account for custom domain email forwarding service.'
    ],
    '/disposable-addresses': [
      'Disposable Email Addresses for Custom Domains',
      'Get disposable email forwarding addresses using your custom domain name.'
    ],
    '/resources': [
      `Free Startup and Developer Email Tools List in <span class="notranslate">${dayjs(
        now
      ).format('YYYY')}</span>`,
      'Get free startup and developer email tools, bundles, resources, guides, tutorials, code samples, and more.'
    ],
    '/blog/docs': [
      `Free Email Developer Tools and Resources in <span class="notranslate">${dayjs(
        now
      ).format('YYYY')}</span>`,
      'Free email developer tools and resources for startups and businesses. See our complete RESTful email API reference and manage your custom domains and aliases.'
    ],
    // TODO: put a number in here
    '/guides': [
      `Top Email Hosting and Email Forwarding Setup Tutorials in <span class="notranslate">${dayjs(
        now
      ).format('YYYY')}</span>`,
      'Follow our free email forwarding and hosting guides to send and receive mail with your custom domain. We publish an email hosting guide list of the most popular website and DNS providers.'
    ],
    '/guides/send-email-with-custom-domain-smtp': [
      `How to Setup Email for Custom Domain Name in <span class="notranslate">${dayjs(
        now
      ).format('YYYY')}</span>`,
      'Set up free email forwarding and email hosting with your custom domain, DNS, SMTP, IMAP, and POP3 configuration step by step guide.'
    ],
    '/guides/send-mail-as-gmail-custom-domain': [
      `How to Send Mail As for Gmail Alias <span class="notranslate">${dayjs(
        now
      ).format('YYYY')}</span>`,
      'Set up email forwarding for free with custom domain and Gmail to forward, send, and receive email. Send mail as not working? Follow our video and instructions.'
    ],
    '/guides/port-25-blocked-by-isp-workaround': [
      'Port 25 blocked by ISP',
      'Workaround port blocking set by your Internet Service Provider on port 25.'
    ],
    '/domain-registration': [
      'Register Custom Domain for Email',
      'Buy a custom domain name for email forwarding.'
    ],
    '/reserved-email-addresses': [
      'Reserved Email Addresses For Administrators',
      'List of 1250+ email addresses reserved for security concerns.'
    ],
    '/my-account': [
      'My Account',
      `Manage your ${config.appName} account, domains, and email forwarding aliases.`
    ],
    '/my-account/domains': [
      'My Domains',
      `Manage your ${config.appName} domains.`
    ],
    '/my-account/emails': [
      'My Emails',
      `Manage your ${config.appName} emails.`
    ],
    '/my-account/logs': ['My Logs', `Manage your ${config.appName} logs.`],
    '/my-account/profile': [
      'My Profile',
      `Manage your ${config.appName} profile.`
    ],
    '/my-account/billing': [
      'My Billing',
      `Manage your ${config.appName} billing.`
    ],
    '/my-account/security': [
      'My Security',
      `Manage your ${config.appName} security.`
    ],
    '/admin': [`Admin ${lad}`, `Access your ${config.appName} admin.`],
    '/forgot-password': [
      'Forgot Password',
      'Reset your account password to regain access to your account.'
    ],
    '/reset-password': ['Reset Password', 'Confirm your password reset token.'],
    '/auth': [`Auth ${lad}`, 'Authenticate yourself to log in.']
  };

  // guides for each provider
  for (const provider of nsProviders) {
    meta[`/guides/${provider.slug}`] = [
      `How to Setup Email with <span class="notranslate">${
        provider.name
      }</span> in <span class="notranslate">${dayjs(now).format(
        'YYYY'
      )}</span>`,
      `How to send and receive emails with <span class="notranslate">${provider.name}</span> DNS and setup free email forwarding for <span class="notranslate">${provider.name}</span> with video and step by step instructions.`
    ];
  }

  if (platforms.length > 0) {
    meta['/blog/open-source'] = [
      `Top ${
        platforms.length
      } Open Source Email Clients and Servers in <span class="notranslate">${dayjs(
        now
      ).format('YYYY')}</span>`,
      'Open-source email client and server reviews, side by side comparisons, screenshots, and step by step setup tutorial guides.'
      // `Open-source email client and server reviews, side by side comparisons, screenshots, and step by step setup tutorial guides for ${arrayJoinConjunction(
      //   [
      //     'Linux',
      //     ...platforms.filter((p) => !p.toLowerCase().includes('linux'))
      //   ]
      // )}.`
    ];
  }

  for (const [i, platform] of platforms.entries()) {
    let sample;
    if (i < 3) {
      sample = 'Top';
    } else if (i < 6) {
      sample = 'Best';
    } else if (i < 9) {
      sample = 'Top-Rated';
    } else if (i < 12) {
      sample = 'Most Popular';
    } else if (i < 15) {
      sample = 'Highest-Rated';
    } else if (i < 18) {
      sample = 'Greatest';
    } else if (i < 21) {
      sample = 'Amazing';
    } else if (i < 24) {
      sample = 'Excellent';
    } else if (i < 27) {
      sample = 'Favorited';
    } else if (i < 30) {
      sample = 'Notable';
    } else if (i < 33) {
      sample = 'Leading';
    } else if (i < 36) {
      sample = 'Outstanding';
    } else if (i < 39) {
      sample = 'Important';
    } else if (i < 41) {
      sample = 'Mighty';
    } else if (i < 44) {
      sample = 'Best';
    } else {
      sample = 'Top';
    }

    // email server
    const serverCount = getServersOrClientsList(platform, false).length;
    meta[`/blog/open-source/${dashify(platform)}-email-server`] = [
      `${serverCount} ${sample} Open Source Email Servers for <span class="notranslate">${platform}</span> in <span class="notranslate">${dayjs(
        now
      ).format('YYYY')}</span>`,
      `The ${serverCount} ${sample.toLowerCase()} free and open-source email servers for <span class="notranslate">${platform}</span> with step guides, tutorials, videos, and instructions.`
    ];

    // email client
    const clientCount = getServersOrClientsList(platform, true).length;
    meta[`/blog/open-source/${dashify(platform)}-email-clients`] = [
      `${clientCount} ${sample} Open Source Email Clients for <span class="notranslate">${platform}</span> in <span class="notranslate">${dayjs(
        now
      ).format('YYYY')}</span>`,
      `Reviews, comparison, screenshots and more for the ${clientCount} ${sample.toLowerCase()} open-source email clients for <span class="notranslate">${platform}</span>.`
    ];
  }

  // developer docs
  for (const doc of developerDocs) {
    if (doc.notCodeExample) {
      meta[doc.slug] = [
        `${doc.title} in <span class="notranslate">${dayjs(now).format(
          'YYYY'
        )}</span>`,
        doc.description
      ];
    } else {
      meta[doc.slug] = [
        `${doc.title} Code Example in <span class="notranslate">${dayjs(
          now
        ).format('YYYY')}</span>`,
        doc.description
      ];
    }
  }

  meta[config.loginRoute] = [
    `Log in ${lad}`,
    'Log in to your free email forwarding service account.'
  ];
  meta[config.verifyRoute] = [
    `Verify email ${lad}`,
    `Verify your ${config.appName} email address.`
  ];
  meta[config.otpRoutePrefix] = [
    `Two Factor Auth ${lad}`,
    'Authenticate yourself with optional OTP to log in.'
  ];
  return meta;
};
