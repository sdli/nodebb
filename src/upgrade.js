'use strict';


var db = require('./database');
var async = require('async');
var winston = require('winston');

var Upgrade = {};

var minSchemaDate = Date.UTC(2016, 8, 7);		// This value gets updated every new MAJOR version
var schemaDate;
var thisSchemaDate;

// IMPORTANT: REMEMBER TO UPDATE VALUE OF latestSchema
var latestSchema = Date.UTC(2017, 3, 16);

Upgrade.check = function (callback) {
	db.get('schemaDate', function (err, value) {
		if (err) {
			return callback(err);
		}

		if (!value) {
			db.set('schemaDate', latestSchema, function (err) {
				if (err) {
					return callback(err);
				}
				callback(null);
			});
			return;
		}

		var schema_ok = parseInt(value, 10) >= latestSchema;
		callback(!schema_ok ? new Error('schema-out-of-date') : null);
	});
};

Upgrade.update = function (schemaDate, callback) {
	db.set('schemaDate', schemaDate, callback);
};

Upgrade.upgrade = function (callback) {
	var updatesMade = false;

	winston.info('Beginning database schema update');

	async.series([
		function (next) {
			// Prepare for upgrade & check to make sure the upgrade is possible
			db.get('schemaDate', function (err, value) {
				if (err) {
					return next(err);
				}

				if (!value) {
					db.set('schemaDate', latestSchema, function () {
						next();
					});
					schemaDate = latestSchema;
				} else {
					schemaDate = parseInt(value, 10);
				}

				if (schemaDate >= minSchemaDate) {
					next();
				} else {
					next(new Error('upgrade-not-possible'));
				}
			});
		},
		function (next) {
			thisSchemaDate = Date.UTC(2016, 8, 22);

			if (schemaDate < thisSchemaDate) {
				updatesMade = true;
				winston.info('[2016/09/22] Setting category recent tids');


				db.getSortedSetRange('categories:cid', 0, -1, function (err, cids) {
					if (err) {
						return next(err);
					}

					async.eachSeries(cids, function (cid, next) {
						db.getSortedSetRevRange('cid:' + cid + ':pids', 0, 0, function (err, pid) {
							if (err || !pid) {
								return next(err);
							}
							db.getObjectFields('post:' + pid, ['tid', 'timestamp'], function (err, postData) {
								if (err || !postData || !postData.tid) {
									return next(err);
								}
								db.sortedSetAdd('cid:' + cid + ':recent_tids', postData.timestamp, postData.tid, next);
							});
						});
					}, function (err) {
						if (err) {
							return next(err);
						}

						winston.info('[2016/09/22] Setting category recent tids - done');
						Upgrade.update(thisSchemaDate, next);
					});
				});
			} else {
				winston.info('[2016/09/22] Setting category recent tids - skipped!');
				next();
			}
		},
		function (next) {
			function upgradePosts(next) {
				var batch = require('./batch');

				batch.processSortedSet('posts:pid', function (ids, next) {
					async.each(ids, function (id, next) {
						console.log('processing pid ' + id);
						async.waterfall([
							function (next) {
								db.rename('pid:' + id + ':users_favourited', 'pid:' + id + ':users_bookmarked', next);
							},
							function (next) {
								db.getObjectField('post:' + id, 'reputation', next);
							},
							function (reputation, next) {
								if (parseInt(reputation, 10)) {
									db.setObjectField('post:' + id, 'bookmarks', reputation, next);
								} else {
									next();
								}
							},
							function (next) {
								db.deleteObjectField('post:' + id, 'reputation', next);
							},
						], next);
					}, next);
				}, {}, next);
			}

			function upgradeUsers(next) {
				var batch = require('./batch');

				batch.processSortedSet('users:joindate', function (ids, next) {
					async.each(ids, function (id, next) {
						console.log('processing uid ' + id);
						db.rename('uid:' + id + ':favourites', 'uid:' + id + ':bookmarks', next);
					}, next);
				}, {}, next);
			}

			thisSchemaDate = Date.UTC(2016, 9, 8);

			if (schemaDate < thisSchemaDate) {
				updatesMade = true;
				winston.info('[2016/10/8] favourite -> bookmark refactor');
				async.series([upgradePosts, upgradeUsers], function (err) {
					if (err) {
						return next(err);
					}
					winston.info('[2016/08/05] favourite- bookmark refactor done!');
					Upgrade.update(thisSchemaDate, next);
				});
			} else {
				winston.info('[2016/10/8] favourite -> bookmark refactor - skipped!');
				next();
			}
		},
		function (next) {
			thisSchemaDate = Date.UTC(2016, 9, 14);

			if (schemaDate < thisSchemaDate) {
				updatesMade = true;
				winston.info('[2016/10/14] Creating sorted sets for post replies');

				var posts = require('./posts');
				var batch = require('./batch');
				batch.processSortedSet('posts:pid', function (ids, next) {
					posts.getPostsFields(ids, ['pid', 'toPid', 'timestamp'], function (err, data) {
						if (err) {
							return next(err);
						}

						async.eachSeries(data, function (postData, next) {
							if (!parseInt(postData.toPid, 10)) {
								return next(null);
							}
							console.log('processing pid: ' + postData.pid + ' toPid: ' + postData.toPid);
							async.parallel([
								async.apply(db.sortedSetAdd, 'pid:' + postData.toPid + ':replies', postData.timestamp, postData.pid),
								async.apply(db.incrObjectField, 'post:' + postData.toPid, 'replies'),
							], next);
						}, next);
					});
				}, function (err) {
					if (err) {
						return next(err);
					}

					winston.info('[2016/10/14] Creating sorted sets for post replies - done');
					Upgrade.update(thisSchemaDate, next);
				});
			} else {
				winston.info('[2016/10/14] Creating sorted sets for post replies - skipped!');
				next();
			}
		},
		function (next) {
			thisSchemaDate = Date.UTC(2016, 10, 22);

			if (schemaDate < thisSchemaDate) {
				updatesMade = true;
				winston.info('[2016/11/22] Update global and user language keys');

				var user = require('./user');
				var meta = require('./meta');
				var batch = require('./batch');
				var newLanguage;
				var i = 0;
				var j = 0;
				async.parallel([
					function (next) {
						meta.configs.get('defaultLang', function (err, defaultLang) {
							if (err) {
								return next(err);
							}

							if (!defaultLang) {
								return setImmediate(next);
							}

							newLanguage = defaultLang.replace('_', '-').replace('@', '-x-');
							if (newLanguage !== defaultLang) {
								meta.configs.set('defaultLang', newLanguage, next);
							} else {
								setImmediate(next);
							}
						});
					},
					function (next) {
						batch.processSortedSet('users:joindate', function (ids, next) {
							async.each(ids, function (uid, next) {
								async.waterfall([
									async.apply(db.getObjectField, 'user:' + uid + ':settings', 'userLang'),
									function (language, next) {
										i += 1;
										if (!language) {
											return setImmediate(next);
										}

										newLanguage = language.replace('_', '-').replace('@', '-x-');
										if (newLanguage !== language) {
											j += 1;
											user.setSetting(uid, 'userLang', newLanguage, next);
										} else {
											setImmediate(next);
										}
									},
								], next);
							}, next);
						}, next);
					},
				], function (err) {
					if (err) {
						return next(err);
					}

					winston.info('[2016/11/22] Update global and user language keys - done (' + i + ' processed, ' + j + ' updated)');
					Upgrade.update(thisSchemaDate, next);
				});
			} else {
				winston.info('[2016/11/22] Update global and user language keys - skipped!');
				next();
			}
		},
		function (next) {
			thisSchemaDate = Date.UTC(2016, 10, 25);

			if (schemaDate < thisSchemaDate) {
				updatesMade = true;
				winston.info('[2016/11/25] Creating sorted sets for pinned topcis');

				var topics = require('./topics');
				var batch = require('./batch');
				batch.processSortedSet('topics:tid', function (ids, next) {
					topics.getTopicsFields(ids, ['tid', 'cid', 'pinned', 'lastposttime'], function (err, data) {
						if (err) {
							return next(err);
						}

						data = data.filter(function (topicData) {
							return parseInt(topicData.pinned, 10) === 1;
						});

						async.eachSeries(data, function (topicData, next) {
							console.log('processing tid: ' + topicData.tid);

							async.parallel([
								async.apply(db.sortedSetAdd, 'cid:' + topicData.cid + ':tids:pinned', Date.now(), topicData.tid),
								async.apply(db.sortedSetRemove, 'cid:' + topicData.cid + ':tids', topicData.tid),
								async.apply(db.sortedSetRemove, 'cid:' + topicData.cid + ':tids:posts', topicData.tid),
							], next);
						}, next);
					});
				}, function (err) {
					if (err) {
						return next(err);
					}

					winston.info('[2016/11/25] Creating sorted sets for pinned topics - done');
					Upgrade.update(thisSchemaDate, next);
				});
			} else {
				winston.info('[2016/11/25] Creating sorted sets for pinned topics - skipped!');
				next();
			}
		},
		function (next) {
			thisSchemaDate = Date.UTC(2017, 1, 25);
			var schemaName = '[2017/2/25] Update global and user sound settings';

			if (schemaDate < thisSchemaDate) {
				updatesMade = true;
				winston.verbose(schemaName);

				var meta = require('./meta');
				var batch = require('./batch');

				var map = {
					'notification.mp3': 'Default | Deedle-dum',
					'waterdrop-high.mp3': 'Default | Water drop (high)',
					'waterdrop-low.mp3': 'Default | Water drop (low)',
				};

				async.parallel([
					function (cb) {
						var keys = ['chat-incoming', 'chat-outgoing', 'notification'];

						db.getObject('settings:sounds', function (err, settings) {
							if (err || !settings) {
								return cb(err);
							}

							keys.forEach(function (key) {
								if (settings[key] && settings[key].indexOf(' | ') === -1) {
									settings[key] = map[settings[key]] || '';
								}
							});

							meta.configs.setMultiple(settings, cb);
						});
					},
					function (cb) {
						var keys = ['notificationSound', 'incomingChatSound', 'outgoingChatSound'];

						batch.processSortedSet('users:joindate', function (ids, next) {
							async.each(ids, function (uid, next) {
								db.getObject('user:' + uid + ':settings', function (err, settings) {
									if (err || !settings) {
										return next(err);
									}
									var newSettings = {};
									keys.forEach(function (key) {
										if (settings[key] && settings[key].indexOf(' | ') === -1) {
											newSettings[key] = map[settings[key]] || '';
										}
									});

									if (Object.keys(newSettings).length) {
										db.setObject('user:' + uid + ':settings', newSettings, next);
									} else {
										setImmediate(next);
									}
								});
							}, next);
						}, cb);
					},
				], function (err) {
					if (err) {
						return next(err);
					}
					winston.info(schemaName + ' - done');
					Upgrade.update(thisSchemaDate, next);
				});
			} else {
				winston.info(schemaName + ' - skipped!');
				next();
			}
		},
		function (next) {
			thisSchemaDate = Date.UTC(2017, 1, 28);
			var schemaName = '[2017/2/28] Update urls in config to `/assets`';

			if (schemaDate < thisSchemaDate) {
				updatesMade = true;
				winston.info(schemaName);
				async.waterfall([
					function (cb) {
						db.getObject('config', cb);
					},
					function (config, cb) {
						if (!config) {
							return cb();
						}

						var keys = ['brand:favicon', 'brand:touchicon', 'og:image', 'brand:logo:url', 'defaultAvatar', 'profile:defaultCovers'];

						keys.forEach(function (key) {
							var oldValue = config[key];

							if (!oldValue || typeof oldValue !== 'string') {
								return;
							}

							config[key] = oldValue.replace(/(?:\/assets)?\/(images|uploads)\//g, '/assets/$1/');
						});

						db.setObject('config', config, cb);
					},
					function (next) {
						winston.info(schemaName + ' - done');
						Upgrade.update(thisSchemaDate, next);
					},
				], next);
			} else {
				winston.info(schemaName + ' - skipped!');
				next();
			}
		},
		function (next) {
			thisSchemaDate = Date.UTC(2017, 3, 16);
			var schemaName = '[2017/4/16] Delete sessions';

			if (schemaDate < thisSchemaDate) {
				updatesMade = true;
				winston.info(schemaName);

				var configJSON = require('../config.json');
				var isRedisSessionStore = configJSON.hasOwnProperty('redis');

				async.waterfall([
					function (next) {
						if (isRedisSessionStore) {
							var rdb = require('./database/redis');
							var client = rdb.connect();
							async.waterfall([
								function (next) {
									client.keys('sess:*', next);
								},
								function (sessionKeys, next) {
									async.eachSeries(sessionKeys, function (key, next) {
										client.del(key, next);
									}, next);
								},
							], function (err) {
								next(err);
							});
						} else {
							db.client.collection('sessions').deleteMany({}, {}, function (err) {
								next(err);
							});
						}
					},
					function (next) {
						winston.info(schemaName + ' - done');
						Upgrade.update(thisSchemaDate, next);
					},
				], next);
			} else {
				winston.info(schemaName + ' - skipped!');
				next();
			}
		},
		// Add new schema updates here
		// IMPORTANT: REMEMBER TO UPDATE VALUE OF latestSchema IN LINE 24!!!
	], function (err) {
		if (!err) {
			if (updatesMade) {
				winston.info('[upgrade] Schema update complete!');
			} else {
				winston.info('[upgrade] Schema already up to date!');
			}
		} else {
			switch (err.message) {
			case 'upgrade-not-possible':
				winston.error('[upgrade] NodeBB upgrade could not complete, as your database schema is too far out of date.');
				winston.error('[upgrade]   Please ensure that you did not skip any minor version upgrades.');
				winston.error('[upgrade]   (e.g. v0.1.x directly to v0.3.x)');
				break;

			default:
				winston.error('[upgrade] Errors were encountered while updating the NodeBB schema: ' + err.message);
				break;
			}
		}

		if (typeof callback === 'function') {
			callback(err);
		} else {
			process.exit();
		}
	});
};

module.exports = Upgrade;
