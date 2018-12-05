
var url = require("url")
var fs = require('fs');
var xmlrpc = require("@electorrent/xmlrpc");

const URL_REGEX = /^[a-z]+:\/\/(?:[a-z0-9-]+\.)*((?:[a-z0-9-]+\.)[a-z]+)/

function Rtorrent(option) {
    this.mode = (option && option['mode']) || "xmlrpc";
    this.host = (option && option['host']) || "127.0.0.1";
    this.port = (option && option['port']) || 80;
    this.path = (option && option['path']) || "/RPC2";
    this.user = (option && option['user']) || null;
    this.pass = (option && option['pass']) || null;
    this.ssl  = (option && option['ssl'])  || false;
    this.ca   = (option && option['ca'])   || undefined;
    this.timeout = (option && option['timeout']) || 5000;
    this.client = null;

    if (this.mode == 'xmlrpc')
    {
        options = {
            host: this.host,
            port: this.port,
            path: this.path,
            headers: {
                'User-Agent': 'NodeJS XML-RPC Client',
                'Content-Type': 'text/xml',
                'Accept': 'text/xml',
                'Accept-Charset': 'UTF8',
                'Connection': 'Close'
            },
            ca: this.ca,
            timeout: this.timeout,
        }

        if (this.user && this.pass) {
            options.username = this.user
            options.password = this.pass
        }

        this.client = (this.ssl) ? xmlrpc.createSecureClient(options) : xmlrpc.createClient(options);
    }
    else
    {
        throw new Error('unknown mode: '+this.mode+' (available: xmlrpc)');
    }
};


Rtorrent.prototype.get = function(method, param, callback) {
    return this.getXmlrpc(method, param, callback);
};

Rtorrent.prototype.getXmlrpc = function(method, params, callback) {
    this.client.methodCall(method, params, callback);
};

Rtorrent.prototype.execute = function(cmd, callback) {
    return this.get('execute.capture', ['bash', '-c', cmd], callback);
};

Rtorrent.prototype.getMulticall = function(method, param, cmds, callback) {
    var self = this;
    var cmdarray = param;

    for (var c in cmds)
        cmdarray.push(postfix(cmds[c]));

    self.get(method, cmdarray, function (err, data) {
        if (err) return callback(err);

        var res = doublearray2hash(data, Object.keys(cmds));
        callback(err, res);
    });
};

Rtorrent.prototype.getMulticallHashes = function(hashes, cmds, params, callback) {
    var array = [];

    for (var h in hashes) {
        for (var c in cmds) {
            var param = params[c]
            param = param === undefined ? [] : [param]
            array.push({
                'methodName': cmds[c],
                'params': [hashes[h], ...param],
            });
        }
    }

    this.getXmlrpc('system.multicall', [array], callback);
}

Rtorrent.prototype.getAll = function(callback) {
    var self = this;

    self.getGlobals(function (err, globals) {
        if (err) return callback(err);

        self.getTorrents(function (err, torrents) {
            if (err) return callback(err);

            var array = [];

            for (var t in torrents) {
                var params = [];
                params.push(torrents[t].hash);
                params.push('');
                for (var f in fields.files)
                    params.push(fields.files[f]+'=');
                array.push({'methodName': 'f.multicall', params: params})
            }

            for (var t in torrents) {
                var params = [];
                params.push(torrents[t].hash);
                params.push('');
                for (var f in fields.trackers)
                    params.push(fields.trackers[f]+'=');
                array.push({'methodName': 't.multicall', params: params})
            }

            for (var t in torrents) {
                var params = [];
                params.push(torrents[t].hash);
                params.push('');
                for (var f in fields.peers)
                    params.push(fields.peers[f]+'=');
                array.push({'methodName': 'p.multicall', params: params})
            }

            self.getXmlrpc('system.multicall', [array], function (err, data) {

                var nb = torrents.length;
                for (var i = 0; i < nb; i++)
                {
                    torrents[i]['files'] = doublearray2hash(data[i][0], Object.keys(fields.files));
                    torrents[i]['trackers'] = doublearray2hash(data[i+nb][0], Object.keys(fields.trackers));
                    torrents[i]['peers'] = doublearray2hash(data[i+nb+nb][0], Object.keys(fields.peers));
                }

                for (var t in torrents)
                    globals.free_disk_space = torrents[t].free_disk_space;

                globals.torrents = torrents;
                callback(err, globals)
            });
        });
    });
};

Rtorrent.prototype.getTorrentsExtra = function(callback) {
    var self = this;

    this.getTorrents(function (err, torrents) {
        if (err) return callback(err);

        var array = [];

        for (var t in torrents) {
            var params = [];
            params.push(torrents[t].hash);
            params.push('');
            for (var f in fields.trackers)
                params.push(fields.trackers[f]+'=');
            array.push({'methodName': 't.multicall', params: params})
        }

        self.getXmlrpc('system.multicall', [array], function (err, data) {

            var nb = torrents.length;
            for (var i = 0; i < nb; i++)
            {
                var trackerdata = doublearray2hash(data[i][0], Object.keys(fields.trackers));

                for (var t in trackerdata) {
                    stringsToBooleans(trackerdata[t], ['enabled', 'open'])
                    stringsToNumbers(trackerdata[t])
                }

                torrents[i]['trackerdata'] = trackerdata
                torrents[i]['trackers'] = trackerdata.map(t => t.url)
                torrents[i]['tracker'] = trackerdata[0] && urlHostname(trackerdata[0]['url'])
                torrents[i]['leechers_total'] = trackerdata.reduce((s,t) => s+t.scrape_incomplete, 0)
                torrents[i]['seeders_total'] = trackerdata.reduce((s,t) => s+t.scrape_complete, 0)
            }

            var labels = torrents.reduce((s,t) => s.add(t.label), new Set())
            var trackers = torrents.reduce((s,t) => s.add(t.tracker), new Set())

            callback(err, {
                torrents: torrents,
                labels: Array.from(labels).filter(l => !!l),
                trackers: Array.from(trackers).filter(t => !!t),
            })
        });
    });
}

Rtorrent.prototype.getTorrents = function(callback) {
    var self = this;

    self.getMulticall('d.multicall2', ['', 'main'], fields.torrents, function (err, data) {
        if (err) return callback(err);

        var bools = ['active', 'open', 'complete', 'hashing', 'hashed']

        for (var i in data)
        {
            stringsToBooleans(data[i], bools)
            stringsToNumbers(data[i])

            data[i]['label'] = decodeURIComponent(data[i]['label'] || '')

            if (data[i]['down_total'] < data[i]['completed'])
                data[i]['down_total'] = data[i]['completed'];

            data[i]['ratio'] = data[i]['up_total']/data[i]['down_total'];
        }

        callback(err, data)
    });
};

Rtorrent.prototype.getTorrentTrackers = function(hash, callback) {
    this.getMulticall('t.multicall', [hash, ''], fields.trackers, callback);
};

Rtorrent.prototype.getTorrentFiles = function(hash, callback) {
    this.getMulticall('f.multicall', [hash, ''], fields.files, callback);
};

Rtorrent.prototype.getTorrentPeers = function(hash, callback) {
    this.getMulticall('p.multicall', [hash, ''], fields.peers, callback);
};

Rtorrent.prototype.systemMulticall = function(cmds, callback) {
    var array = [];

    for (i in cmds)
        array.push({
            'methodName': cmds[i],
            'params': [],
        });

    this.getXmlrpc('system.multicall', [array], function (err, data) {
        if (err) return callback(err);

        var res = {};
        var i = 0;
        for (var key in cmds)
            res[key] = data[i++][0];
        callback(err, res);
    });
};

Rtorrent.prototype.getGlobals = function(callback) {
   this.systemMulticall(fields.global, callback);
};

Rtorrent.prototype.start = function(hashes, callback) {
    var self = this;
    this.getMulticallHashes(hashes, ['d.open'], [], function(err, data) {
        if(err) return callback(err);

        self.getMulticallHashes(hashes, ['d.start'], [], callback)
    })
}

Rtorrent.prototype.pause = function(hashes, callback) {
    this.getMulticallHashes(hashes, ['d.pause'], [], callback)
}

Rtorrent.prototype.stop = function(hashes, callback) {
    var self = this;
    this.getMulticallHashes(hashes, ['d.stop'], [], function(err, data) {
        if(err) return callback(err);

        self.getMulticallHashes(hashes, ['d.close'], [], callback)
    })
}

Rtorrent.prototype.remove = function(hashes, callback) {
    this.getMulticallHashes(hashes, ['d.erase'], [], callback)
};

Rtorrent.prototype.removeAndErase = function(hashes, callback) {
    this.getMulticallHashes(hashes, ['d.custom5.set', 'd.delete_tied', 'd.erase'], ['1'], callback)
}

Rtorrent.prototype.setLabel = function(hashes, label, callback) {
    this.getMulticallHashes(hashes, ['d.custom1.set'], [label], callback)
}

Rtorrent.prototype.setPriorityHigh = function(hashes, callback) {
    this.getMulticallHashes(hashes, ['d.priority.set'], [3], callback)
}

Rtorrent.prototype.setPriorityNormal = function(hashes, callback) {
    this.getMulticallHashes(hashes, ['d.priority.set'], [2], callback)
}

Rtorrent.prototype.setPriorityLow = function(hashes, callback) {
    this.getMulticallHashes(hashes, ['d.priority.set'], [1], callback)
}

Rtorrent.prototype.setPriorityOff = function(hashes, callback) {
    this.getMulticallHashes(hashes, ['d.priority.set'], [0], callback)
}

Rtorrent.prototype.recheck = function(hashes, callback) {
    this.getMulticallHashes(hashes, ['d.check_hash'], [], callback)
}

Rtorrent.prototype.loadLink = function(link, callback) {
    this.get('load.start', ['', link], callback);
};

Rtorrent.prototype.loadFile = function(filePath, callback) {
    var file = fs.readFileSync(filePath);
    this.loadFileContent(file, callback);
};

Rtorrent.prototype.loadFileContent = function(filecontent, callback) {
    if (!Buffer.isBuffer(filecontent)) {
        filecontent = Buffer.from(filecontent)
    }
    this.get('load.raw_start', ['', filecontent], callback);
};

Rtorrent.prototype.setPath = function(hash, directory, callback) {
    this.get('d.directory.set', [hash, directory], callback);
};

module.exports = Rtorrent;



var fields = {
    global: {
        up_rate: 'throttle.global_up.rate',
        down_rate: 'throttle.global_down.rate',
        up_total: 'throttle.global_up.total',
        down_total: 'throttle.global_down.total',
        bind: 'network.bind_address',
        check_hash: 'pieces.hash.on_completion',
        dht_port: 'dht.port',
        directory: 'directory.default',
        download_rate: 'throttle.global_down.max_rate',
        http_cacert: 'network.http.cacert',
        http_capath: 'network.http.capath',
        http_proxy: 'network.http.proxy_address',
        ip: 'network.local_address',
        max_downloads_div: 'throttle.max_downloads.div',
        max_downloads_global: 'throttle.max_downloads.global',
        max_file_size: 'system.file.max_size',
        max_memory_usage: 'pieces.memory.max',
        max_open_files: 'network.max_open_files',
        max_open_http: 'network.http.max_open',
        max_peers: 'throttle.max_peers.normal',
        max_peers_seed: 'throttle.max_peers.seed',
        max_uploads: 'throttle.max_uploads',
        max_uploads_global: 'throttle.max_uploads.global',
        min_peers_seed: 'throttle.min_peers.seed',
        min_peers: 'throttle.min_peers.normal',
        peer_exchange: 'protocol.pex',
        port_open: 'network.port_open',
        upload_rate: 'throttle.global_up.max_rate',
        port_random: 'network.port_random',
        port_range: 'network.port_range',
        preload_min_size: 'pieces.preload.min_size',
        preload_required_rate: 'pieces.preload.min_rate',
        preload_type: 'pieces.preload.type',
        proxy_address: 'network.proxy_address',
        receive_buffer_size: 'network.receive_buffer.size',
        safe_sync: 'pieces.sync.always_safe',
        scgi_dont_route: 'network.scgi.dont_route',
        send_buffer_size: 'network.send_buffer.size',
        session: 'session.path',
        session_lock: 'session.use_lock',
        session_on_completion: 'session.on_completion',
        split_file_size: 'system.file.split_size',
        split_suffix: 'system.file.split_suffix',
        timeout_safe_sync: 'pieces.sync.timeout_safe',
        timeout_sync: 'pieces.sync.timeout',
        tracker_numwant: 'trackers.numwant',
        use_udp_trackers: 'trackers.use_udp',
        max_uploads_div: 'throttle.max_uploads.div',
        max_open_sockets: 'network.max_open_sockets'
    },
    peers: {
        address: 'p.address',
        client_version: 'p.client_version',
        completed_percent: 'p.completed_percent',
        down_rate: 'p.down_rate',
        down_total: 'p.down_total',
        id: 'p.id',
        port: 'p.port',
        up_rate: 'p.up_rate',
        up_total: 'p.up_total'
    },
    files: {
        range_first: 'f.range_first',
        range_second: 'f.range_second',
        size: 'f.size_bytes',
        chunks: 'f.size_chunks',
        completed_chunks: 'f.completed_chunks',
        fullpath: 'f.frozen_path',
        path: 'f.path',
        priority: 'f.priority',
        is_created: 'f.is_created=',
        is_open: 'f.is_open=',
        last_touched: 'f.last_touched=',
        match_depth_next: 'f.match_depth_next=',
        match_depth_prev: 'f.match_depth_prev=',
        offset: 'f.offset=',
        path_components: 'f.path_components=',
        path_depth: 'f.path_depth=',
    },
    trackers: {
        id: 't.id',
        group: 't.group',
        type: 't.type',
        url: 't.url',
        enabled: 't.is_enabled',
        open: 't.is_open',
        min_interval: 't.min_interval',
        normal_interval: 't.normal_interval',
        scrape_complete: 't.scrape_complete',
        scrape_downloaded: 't.scrape_downloaded',
        scrape_incomplete: 't.scrape_incomplete',
        scrape_time_last: 't.scrape_time_last',
    },
    torrents: {
        hash: 'd.hash',
        torrent: 'd.tied_to_file',
        torrentsession: 'd.loaded_file',
        path: 'd.base_path',
        name: 'd.name',
        size: 'd.size_bytes',
        skip: 'd.skip.total',
        completed: 'd.completed_bytes',
        down_rate: 'd.down.rate',
        down_total: 'd.down.total',
        up_rate: 'd.up.rate',
        up_total: 'd.up.total',
        message: 'd.message',
        bitfield: 'd.bitfield',
        chunk_size: 'd.chunk_size',
        chunk_completed: 'd.completed_chunks',
        createdAt: 'd.creation_date',
        active: 'd.is_active',
        open: 'd.is_open',
        complete: 'd.complete',
        hashing: 'd.is_hash_checking',
        hashed: 'd.is_hash_checked',
        leechers: 'd.peers_accounted',
        seeders: 'd.peers_complete',
        free_disk_space: 'd.free_diskspace',
        left_bytes: 'd.left_bytes',
        label: 'd.custom1',
        addtime: 'd.custom=addtime',
    },
};

function postfix(param) {
    if (param.includes('=')) {
        return param
    } else {
        return param+'='
    }
}

function urlHostname(url) {
    var match = url.match(URL_REGEX)
    return match && match[1]
}

function stringsToNumbers(object) {
    let keys = Object.keys(object)
    for (let key of keys) {
        if (key === 'hash' || key === 'name')
            continue
        let number = parseFloat(object[key])
        if (!isNaN(number))
            object[key] = number
    }
}

function stringsToBooleans(object, keys) {
    for (var key of keys) {
        object[key] = !!parseInt(object[key])
    }
}

function array2hash(array, keys) {
    var i = 0;
    var res = {};
    for (var k in keys) {
        res[keys[k]] = array[i++];
    }
    return res;
}

function doublearray2hash(array, keys) {
    for (var i in array)
        array[i] = array2hash(array[i], keys);
    return array;
}
