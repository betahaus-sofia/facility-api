'use strict';

require('dotenv').config({ silent: true });
const env = process.env;

// Server
// Used for ping and Heroku's web process
const http = require('http');
const port = env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(new Date().toISOString());
});

server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

// Firebase + Slack
const { parallel } = require('async');
const firebase = require('firebase');
const moment = require('moment');
const Slack = require('node-slack');
const slack = new Slack(env.SLACK_WEBHOOK_URL);

initializeFirebaseApp();
watchForSupplyRequests();

// Functions
function initializeFirebaseApp() {
  firebase.initializeApp({
    serviceAccount: {
      project_id: env.FIREBASE_SERVICE_ACCOUNT_PROJECT_ID,
      client_email: env.FIREBASE_SERVICE_ACCOUNT_CLIENT_EMAIL,
      private_key: env.FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, '\n')
    },
    databaseURL: env.FIREBASE_DATABASE_URL
  });
}

function watchForSupplyRequests(objectKeys) {
  const db = firebase.database();

  db.ref('roomSupplies').on('child_added', (roomSupplyChildSnapshot) => {
    db.ref(`roomSupplies/${roomSupplyChildSnapshot.key}`).on('value', (roomSupplySnapshot) => {
      const roomSupply = roomSupplySnapshot.val();
      if (!roomSupply.requested) return;

      // Check if a message has been sent recently
      const cooldown = parseInt(env.SLACK_MESSAGE_COOLDOWN_IN_MINUTES, 10) * 60 * 1e3;
      if (roomSupply.requested - roomSupply.notified < cooldown) return;

      parallel({
        room(next) {
          db.ref(`rooms/${roomSupply.room}`).once('value', (roomSnapshot) => next(null, roomSnapshot.val()));
        },
        supply(next) {
          db.ref(`supplies/${roomSupply.supply}`).once('value', (supplySnapshot) => next(null, supplySnapshot.val()));
        }
      }, (error, results) => {
        if (error) return console.error(error);

        const { room, supply } = results;
        const timestamp = Math.min(roomSupply.requested, Date.now());
        sendSupplyRequestNotificationToSlack(room, supply, timestamp)
          .then(() => {
            db.ref(`roomSupplies/${roomSupplySnapshot.key}`).update({ notified: firebase.database.ServerValue.TIMESTAMP });
          }).catch((error) => {
            console.error(error);
          });
      });
    });
  });
}

function sendSupplyRequestNotificationToSlack(room, supply, timestamp) {
  const timeago = moment(timestamp).fromNow();
  const attachment = {
    color: 'warning',
    fallback: `${supply.name} requested in ${room.name} ${timeago}`,
    text: `*${supply.name}* requested in *${room.name}* _${timeago}_`,
    mrkdwn_in: ['text']
  };

  if (supply.imageUrl) {
    attachment.thumb_url = supply.imageUrl;
  }

  return slack.send({
    attachments: [attachment],
    icon_url: env.SLACK_ICON_URL,
    // Send message without text:
    // https://github.com/xoxco/node-slack/issues/24
    text: { toString: () => '' }
  });
}
