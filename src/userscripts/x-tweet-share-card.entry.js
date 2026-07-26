// ==UserScript==
// @name         X Tweet Share Card
// @namespace    https://github.com/kyangc/tampermonkey_scripts
// @version      0.4.0
// @description  Generate a polished, copyable image card from an X post's share menu.
// @author       kyangc
// @license      AGPL-3.0-or-later
// @homepageURL  https://github.com/kyangc/tampermonkey_scripts
// @supportURL   https://github.com/kyangc/tampermonkey_scripts/issues
// @updateURL    https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/x-tweet-share-card.user.js
// @downloadURL  https://raw.githubusercontent.com/kyangc/tampermonkey_scripts/main/scripts/x-tweet-share-card.user.js
// @match        https://x.com/*
// @match        https://twitter.com/*
// @require      https://raw.githubusercontent.com/kazuhikoarase/qrcode-generator/js2.0.4/js/dist/qrcode.js#sha256-eeyG+ChWAFsciHkFz8z8++w4Icphx/1alS+qX3ePeRw=
// @run-at       document-idle
// @inject-into  content
// @grant        GM.xmlHttpRequest
// @connect      pbs.twimg.com
// @noframes
// ==/UserScript==

// Standalone compatibility entry for tools/build-userscripts.mjs.
