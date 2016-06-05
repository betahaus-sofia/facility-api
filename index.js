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

  db.ref('rooms').on('child_added', (roomSnapshot) => {
    roomSnapshot.child('supplies').forEach((roomSupplySnapshot) => {
      db.ref(`supplies/${roomSupplySnapshot.key}`).on('value', (supplySnapshot) => {
        db.ref('requests')
          .orderByChild('room_supply')
          .equalTo(`${roomSnapshot.key}_${supplySnapshot.key}`)
          .limitToLast(1)
          .on('child_added', (requestSnapshot) => {
            const request = requestSnapshot.val();

            // Check if a message has been sent recently
            db.ref(`messages/${request.room_supply}/delivered`).once('value', (messageDeliveredSnapshot) => {
              const delivered = messageDeliveredSnapshot.val();
              const cooldown = parseInt(env.SLACK_MESSAGE_COOLDOWN_IN_MINUTES, 10) * 60 * 1e3;
              if (request.date - delivered < cooldown) return;

              const supply = supplySnapshot.val();
              const room = roomSnapshot.val();

              const timestamp = Math.min(request.date, Date.now());
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

              slack.send({
                attachments: [attachment],
                icon_url: env.SLACK_ICON_URL,
                // Send message without text:
                // https://github.com/xoxco/node-slack/issues/24
                text: { toString: () => '' }
              }).then(() => {
                db.ref(`messages/${request.room_supply}`).update({
                  delivered: firebase.database.ServerValue.TIMESTAMP
                });
              }).catch((error) => {
                console.log(error)
              });
            });
          });
      });
    });
  });
}
