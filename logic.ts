﻿import express = require('express');
import request = require('request');
import sio = require('socket.io');

import schedule = require('node-schedule');

import * as util from './util';
import * as game from './game';

const games: game.GameManager = new game.GameManager;

function extractClientData(socket: SocketIO.Socket) {
    const client = util.getCookie(socket.request.headers.cookie,
        util.cookiestring);
    if (client === undefined || client == null) {
        return { a: null, b: null, c: 1 };
    }

    if (cookie2player[client] === undefined || cookie2player[client] == null) {
        return { a: null, b: null, c: 2 };
    }

    const game = cookie2game[client];
    if (game === undefined || game == null) {
        return { a: null, b: null, c: 3 };
    }

    if (game2cookies[game] === undefined || game2cookies[game] == null) {
        return { a: null, b: null, c: 4 };
    }

    return { a: client, b: game, c: 0 };
}

/* create at post/create
   update at join */
const game2cookies: { [game: string]: string[] } = {};
/* create at io/use */
const cookie2socket: { [cookie: string]: string } = {};
/* create at io/join */
const cookie2game: { [cookie: string]: string } = {}
/* maintain at io/join */
const cookie2player: { [cookie: string]: number } = {};
/* create at post/create
   maintain at join */
const game2names: { [game: string]: string[] } = {};

/* remove client if they are already in a game */
function removeClientFromGame(client: string): number {
    if (cookie2game[client] !== undefined) {
        const curGame = cookie2game[client];
        const curGameOthers = game2cookies[curGame];
        const newothers: string[] = [];
        for (let other of curGameOthers) {
            if (other != client)
                newothers.push(other);
        }

        game2cookies[curGame] = newothers;
        delete cookie2game[client];

        // success
        return 0;
    }

    else {
        //not in a game right now
        return 1;
    }
}

function leaveJoinedRooms(socket: SocketIO.Socket, cb): void {
    socket.leaveAll();
    socket.join(socket.id, cb);
}

const task = schedule.scheduleJob('42 * * * *', () => {
    for (let game in game2cookies) {
        if (games.remove(game)) {
            for (let client of game2cookies[game]) {
                delete cookie2game[client];
                delete cookie2player[client];
            }
            delete game2cookies[game];
            delete game2names[game];
        }
    }

    return;
});

//TODO: admin stuffz, admin backdoors
export default (app: express.Application, io: SocketIO.Server) => {
    app.post('/create', (req: express.Request, res: express.Response) => {
        if (req.body['g-recaptcha-response'] === undefined || req.body['g-recaptcha-response'] === '' || req.body['g-recaptcha-response'] === null) {
            return res.json({ "pass": false, "reason": "no recaptcha" });
        }
        const secretKey = process.env.recaptcha_key;
        const verificationURL = "https://www.google.com/recaptcha/api/siteverify?secret=" + secretKey + "&response=" + req.body['g-recaptcha-response'] + "&remoteip=" + req.connection.remoteAddress;

        request(verificationURL, (error, response, body) => {
            body = JSON.parse(body);

            if (body.success !== undefined && !body.success) {
                return res.json({ "pass": false, "reason": "recaptcha failed" });
            }

            const gameId: string = util.randomString(10);
            games.createGame(gameId);
            game2cookies[gameId] = [];
            game2names[gameId] = ["Player 1", "Player 2", "Player 3", "Player 4", "Player 5", "Player 6"];
            res.json({ "pass": true, "code": gameId });
        });
    });

    io.use((socket: SocketIO.Socket, next) => {
        const client = util.getCookie(socket.request.headers.cookie,
            util.cookiestring);
        if (client === undefined) {
            return;
        }
        cookie2socket[client] = socket.id;

        next();
    });
    io.on('connection', (socket: SocketIO.Socket) => {
        socket.on('localMessage', (string_data) => {
            const { a: client, b: game, c: status } = extractClientData(socket);

            if (status != 0) return;

            const player = cookie2player[client];
            const name = game2names[game][player];

            const data = JSON.parse(string_data);
            data.user = name;
            string_data = JSON.stringify(data);


            for (let client of game2cookies[game]) {
                const socketid = cookie2socket[client];
                if (socketid === undefined) continue;
                io.to(socketid).emit('localmessage', string_data);
            }

        });
        socket.on('declarealert', (string_data) => {
            const { a: client, b: game, c: status } = extractClientData(socket);

            if (status != 0) return;

            const player = cookie2player[client];
            const name = game2names[game][player];

            for (let client of game2cookies[game]) {
                const socketid = cookie2socket[client];

                if (socketid === undefined || player === undefined) {
                    continue;
                }

                const rdata = {
                    name: name
                };

                io.to(socketid).emit('declarealert', JSON.stringify(rdata));
            }

            return;

        });

        socket.on('join', (string_data) => {
            const data = JSON.parse(string_data);
            const client = util.getCookie(socket.request.headers.cookie,
                util.cookiestring);

            const game = data.game;
            const player = data.player;
            if (client === undefined || game === undefined
                || !games.gameExists(game)
                || util.checkNum(player, util.numPlayers)) {
                socket.emit('joinstatus', JSON.stringify({ success: false, reason: "invalid" }));
                return;
            }

            if (data.name !== undefined && data.name != null) {
                data.name = data.name.toString();
            }
            if (data.name === undefined || data.name === "Player " + (player + 1) || data.name.length == 0) {
                data.name = "Playah #" + (player + 1);
            }

            const others = game2cookies[game];

            if (others.indexOf(client) > -1) {
                socket.emit('joinstatus', JSON.stringify({ success: false, reason: "you already joined" }));
                return;
            }
            else if (others.length >= util.numPlayers) {
                socket.emit('joinstatus', JSON.stringify({ success: false, reason: "already 6 players" }));
                return;
            }

            for (let other of others) {
                if (cookie2player[other] === player) {
                    socket.emit('joinstatus', JSON.stringify({ success: false, reason: "someone else already joined" }));
                    return;
                }
            }

            /* cannot join game if same name */
            for (let i = 0; i < 6; ++i) {
                if (i == player) continue;
                if (game2names[game][i] == data.name) {
                    socket.emit('joinstatus', JSON.stringify({ success: false, reason: "duplicate name" }));
                    return;
                }
            }

            removeClientFromGame(client);

            others.push(client);
            game2cookies[game] = others;
            cookie2game[client] = game;
            cookie2player[client] = player;
            game2names[game][player] = data.name;

            leaveJoinedRooms(socket, () => {
                socket.emit('joinstatus', JSON.stringify({ success: true }));

                for (let client of game2cookies[game]) {
                    const socketid = cookie2socket[client];

                    if (socketid === undefined) {
                        continue;
                    }

                    io.to(socketid).emit('refresh', "");
                }
            });

            return;
        });
        socket.on('watch', (string_data) => {
            const data = JSON.parse(string_data);
            const client = util.getCookie(socket.request.headers.cookie,
                util.cookiestring);

            const game = data.game;
            const player = data.player;

            if (client === undefined || game === undefined
                || !games.gameExists(game)
                || util.checkNum(player, util.numPlayers)) {
                socket.emit('joinstatus', JSON.stringify({ success: false, reason: "invalid" }));
                return;
            }

            removeClientFromGame(client);

            const clients = game2cookies[game];
            for (let client of clients) {
                if (cookie2player[client] == player) {
                    const socketid = cookie2socket[client];

                    leaveJoinedRooms(socket, () => {
                        //may leave the socket in multiple rooms
                        //will need to refresh to way someone new
                        socket.emit('joinstatus', JSON.stringify({ success: true }));

                        socket.join(socketid);

                        const rdata = {
                            gameCode: game,
                            data: games.getData(game, player),
                            player: player,
                            names: game2names[game]
                        };

                        socket.emit('gamestate', JSON.stringify(rdata));

                        if (data.name == null || data.name == "") {
                            io.to(socketid).emit("spectatorjoinedgame", JSON.stringify({}));
                        } else {
                            io.to(socketid).emit("spectatorjoinedgame", JSON.stringify({
                                name: data.name
                            }));
                        }
                    });

                    return;
                }
            }

            socket.emit('joinstatus', JSON.stringify({ success: false, reason: "player hasnt joined yet" }));

            //player not even in game yet!
            return;

        });
        socket.on('makemove', (string_data) => {
            const data = JSON.parse(string_data);
            const { a: client, b: game, c: status } = extractClientData(socket);

            if (status != 0) {
                socket.emit('makemovestatus', JSON.stringify({ success: false }));
                return;
            }
            const player = cookie2player[client];

            games.update(game, player, data);
            //do stuffz here
            for (let client of game2cookies[game]) {
                const socketid = cookie2socket[client];
                const player = cookie2player[client];

                if (socketid === undefined || player === undefined) {
                    continue;
                }

                const rdata = {
                    gameCode: game,
                    data: games.getData(game, player),
                    player: player,
                    names: game2names[game]
                };

                io.to(socketid).emit('gamestate', JSON.stringify(rdata));
            }

            socket.emit('makemovestatus', JSON.stringify({ success: true }));
            return;
        });
        socket.on('leave', (string_data) => {
            const client = util.getCookie(socket.request.headers.cookie,
                util.cookiestring);

            const status: number = removeClientFromGame(client);
            if (status == 0) socket.emit("leavestatus", JSON.stringify({ success: true, reason: "left game" }));
            else if (status == 1) socket.emit("leavestatus", JSON.stringify({ success: true, reason: "nothing to leave" }));
            else socket.emit("leavestatus", JSON.stringify({ success: false, reason: "unknown" }));

        });

        socket.on('gamestate', (should_not_need_to_use_this) => {
            const { a: client, b: game } = extractClientData(socket);
            if (client == null || game == null
                || cookie2player[client] === undefined) {
                socket.emit('gamestatestatus', JSON.stringify({ success: false }));
                return;
            }
            const player = cookie2player[client];
            if (player === undefined) {
                socket.emit('gamestatestatus', JSON.stringify({ success: false }));
                return;
            }
            const rdata = {
                gameCode: game,
                data: games.getData(game, player),
                player: player,
                names: game2names[game]
            };
            socket.emit('gamestate', JSON.stringify(rdata));
            socket.emit('gamestatestatus', JSON.stringify({ success: true }));
            return;
        });
    });

};