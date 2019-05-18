const makeValidator = require('domain-validator'),
      parseWikidataValue = require('wd-type-parser');

function validate(value, name, min, max, isFloat) {
    if (value === undefined) {
        throw new Error('mapsnapshot: parameter ' + name + ' is not set');
    }
    if (!(isFloat ? /^-?[0-9]+\.?[0-9]*$/ : /^-?[0-9]+$/).test(value)) {
        throw new Error('mapsnapshot: parameter ' + name + ' is not a number');
    }
    value = isFloat ? parseFloat(value) : parseInt(value);
    if (value < min || value > max) {
        throw new Error('mapsnapshot: parameter ' + name + ' is not valid');
    }
}

class VegaWrapper2 {
    /**
     * Shared library to wrap around vega code
     * @param {Object} wrapperOpts Configuration options
     * @param {Object} wrapperOpts.loader Vega-loader object, its sanitize(), file() and load() method will be overwrited
     * @param {Object} wrapperOpts.domains allowed protocols and a list of their domains
     * @param {Object} wrapperOpts.domainMap domain remapping
     * @param {Function} wrapperOpts.logger
     * @param {Function} wrapperOpts.formatUrl
     * @param {string} [wrapperOpts.languageCode]
     * @constructor
     */
    constructor(wrapperOpts) {
        // Copy all options into the wrapper
        Object.assign(this, wrapperOpts);
        this.validators = {};

        this.loader.sanitize = this.sanitize.bind(this);
        this.loader.load = (uri, options) => {
            return this.sanitize(uri, options)
                .then(opt => {
                    return this.loader.http(opt.href, options)
                        .then(txt => {
                            return this.parseResponse(txt, uri.type, options);
                        });
                });
        }

        // Prevent accidental use
        this.loader.file = () => { throw new Error('Disabled'); };
    }

    /**
     * Validate and update urlObj to be safe for client-side and server-side usage
     * @param {object} uri - An object that will be converted into an url string
     * @param {object} options - passed by the vega loader
     * @return {Promise} The sanitized url is provided by the 'href' property. We never load file from local file system.
     */
    sanitize(uri, options) {
        return new Promise(function(accept) {
            //return
            accept({href: this.objToUrl(uri, options), loadFile: false});
        });
    }

    /**
     * Check if host was listed in the allowed domains, normalize it, and get correct protocol
     * @param {string} host
     * @returns {Object}
     */
    sanitizeHost(host) {
        // First, map the host
        host = (this.domainMap && this.domainMap[host]) || host;

        if (this.testHost('https', host)) {
            return { host: host, protocol: 'https' };
        } else if (this.testHost('http', host)) {
            return { host: host, protocol: 'http' };
        }
        return undefined;
    };

    /**
     * Test host against the list of allowed domains based on the protocol
     * @param {string} protocol
     * @param {string} host
     * @returns {boolean}
     */
    testHost(protocol, host) {
        if (!this.validators[protocol]) {
            const domains = this.domains[protocol];
            if (domains) {
                this.validators[protocol] = makeValidator(domains, protocol === 'https' || protocol === 'http');
            } else {
                return false;
            }
        }
        return this.validators[protocol].test(host);
    };

    /**
     * Override the protocol and host for *wikidatasparql*, *geoshape*, *geoline* and *mapsnapshot*
     * @param {object} urlParts output the new result to this object
     * @param {object} urlObj used to log and determine the corresponding host
     * @param {string} protocolOverride used to determine the corresponding host
     * @private
     */
    _overrideHostAndProtocol(urlParts, urlObj, protocolOverride) {
        let protocol = protocolOverride || urlObj.type,
            domains = this.domains[protocol];
        if (!domains) {
            throw new Error(protocol + ': protocol is disabled: ' + JSON.stringify(urlObj));
        }
        urlParts.host = domains[0];
        urlParts.protocol = this.sanitizeHost(urlParts.host).protocol;
        if (!this.testHost(protocol, urlParts.host)) {
            throw new Error(protocol + ': URL must either be relative (' + protocol + '///...),'
                + 'or use one of the allowed hosts: ' + JSON.stringify(urlObj));
        }
    }

    /**
     * convert the urlObj to a url string
     * @param {object} urlObj an object consists of type and essential parameters
     * @param {object} options used to attach CORS infomation
     * @returns {string} a complete url
     */
    objToUrl(urlObj, options) {
        let urlParts = {host: urlObj.wiki ? urlObj.wiki : options.domain},
            sanitizedHost = this.sanitizeHost(urlParts.host);

        if (!sanitizedHost) {
            throw new Error('URL hostname is not whitelisted: ' + urlParts.host);
        }
        Object.assign(urlParts, sanitizedHost);

        switch(urlObj.type) {
            case 'wikiapi':
                // {type: “wikiapi”, params: {action:”...”, ... } [, wiki: “en.wikipedia.org”]}
                // Call to api.php - ignores the path parameter, and only uses the query
                if(typeof urlObj.params !== 'object'){
                    throw new Error('wikiapi: "params" should be an object');
                }
                urlParts.query = Object.assign(urlObj.params, {format: 'json', formatversion: '2'});
                urlParts.pathname = '/w/api.php';
                options.addCorsOrigin = true;
                break;

            case 'wikirest':
                // {type: “wikirest”, path: “/rest_v1/page/...” [, wiki: “en.wikipedia.org”]}
                // Call to RESTbase api - requires the path to start with "/api/"
                // The /api/... path is safe for GET requests
                if (!urlObj.path || !urlObj.path.startsWith('/')) {
                    throw new Error('wikirest: url path should begin with "/"');
                }
                urlParts.pathname = '/api' + urlObj.path;
                break;

            case 'wikiraw':
                // {type: “wikiraw”, title: “MyPage” [, wiki: “en.wikipedia.org”]}
                // Get content of a wiki page
                // Uses mediawiki api, and extract the content after the request
                // Query value must be a valid MediaWiki title string, but we only ensure
                // there is no pipe symbol or \x1F, the rest is handled by the api.
                if (!urlObj.title || !/^[^|\x1F]+$/.test(urlObj.title)) {
                    throw new Error('wikiraw: invalid title');
                }
                urlParts.query = {
                    format: 'json',
                    formatversion: '2',
                    action: 'query',
                    prop: 'revisions',
                    rvprop: 'content',
                    titles: urlObj.title
                };

                urlParts.pathname = '/w/api.php';
                options.addCorsOrigin = true;
                break;

            case 'tabular':
            case 'map':
                // { type: 'tabular', title: 'Data.tab' [, lang: 'en'] }
                // { type: 'map', title: 'Data.map' [, lang: 'en'] }
                // Get content of a wiki page belonging to Data namespace
                // Uses mediawiki api, and extract the content after the request
                // Query value must be a valid MediaWiki title string, so we ensure there
                // is no pipe symbol or \x1F and the title ends with .tab or .map
                if (!/^[^|\x1F]+\.(tab|map)$/.test(urlObj.title)) {
                    throw new Error(urlObj.type + ': invalid title');
                }
                urlParts.query = {
                    format: 'json',
                    formatversion: '2',
                    action: 'jsondata',
                    title: urlObj.title
                };
                if (urlObj.lang || this.languageCode) {
                    urlParts.query.uselang = urlObj.lang || this.languageCode;
                }

                urlParts.pathname = '/w/api.php';
                options.addCorsOrigin = true;
                break;

            case 'wikifile':
                // {type: “wikifile”, title: “Einstein_1921.jpg”, [width=100, height=100]}
                // Get an image for the graph, e.g. from commons, by using Special:Redirect
                urlParts.pathname = '/wiki/Special:Redirect/file/' + urlObj.title;
                urlParts.query = {};
                if(urlObj.width) urlParts.query.width = urlObj.width;
                if(urlObj.height) urlParts.query.height = urlObj.height;
                break;

            case 'wikidatasparql':
                // {type: “wikidatasparql”, query: "..."}
                // Runs a SPARQL query, converting it to
                // https://query.wikidata.org/bigdata/namespace/wdq/sparql?format=json&query=...
                this._overrideHostAndProtocol(urlParts, urlObj);
                if (!urlObj.query) {
                    throw new Error('wikidatasparql: missing query parameter');
                }
                urlParts.query = {query: urlObj.query};
                urlParts.pathname = '/bigdata/namespace/wdq/sparql';
                options.headers = Object.assign(options.headers || {}, {'Accept': 'application/sparql-results+json'});
                break;

            case 'geoshape':
            case 'geoline':
                // {type: “geoshape”, [ids: “Q16,Q30” | query:’...’] }
                // Get geoshapes data from OSM database by supplying Wikidata IDs
                // https://maps.wikimedia.org/shape?ids=Q16,Q30
                // 'geoline:' is an identical service, except that it returns lines instead of polygons
                this._overrideHostAndProtocol(urlParts, urlObj, 'geoshape');
                if (!urlObj.ids && !urlObj.query) {
                    throw new Error(urlObj.type + ' missing ids or query parameter in: ' + JSON.stringify(urlObj));
                }
                urlParts.query = {};
                if(urlObj.ids) urlParts.query.ids = urlObj.ids;
                else if(urlObj.query) urlParts.query.query = urlObj.query;
                urlParts.pathname = '/' + urlObj.type;
                break;

            case 'mapsnapshot':
                // {type: “mapsnapshot”,  width:100, height:100, lat:10, lon:10, zoom:5 [, style:'osm', lang:’fr’]}
                // Converts it into a snapshot image request for Kartotherian:
                // https://maps.wikimedia.org/img/{style},{zoom},{lat},{lon},{width}x{height}[@{scale}x].{format}
                // (scale will be set to 2, and format to png)
                validate(urlObj.width, 'width', 1, 4096);
                validate(urlObj.height, 'height', 1, 4096);
                validate(urlObj.zoom, 'zoom', 0, 22);
                validate(urlObj.lat, 'lat', -90, 90, true);
                validate(urlObj.lon, 'lon', -180, 180, true);

                if (urlObj.style && !/^[-_0-9a-z]+$/.test(urlObj.style)) {
                    throw new Error('mapsnapshot: if style is given, it must be letters/numbers/dash/underscores only');
                }
                if (urlObj.lang && !/^[-_0-9a-zA-Z]+$/.test(urlObj.lang)) {
                    throw new Error('mapsnapshot: if lang is given, it must be letters/numbers/dash/underscores only');
                }

                // Uses the same configuration as geoshape service, so reuse settings
                this._overrideHostAndProtocol(urlParts, urlObj, 'geoshape');

                urlParts.pathname = '/img/' + (urlObj.style || 'osm-intl') + ',' + urlObj.zoom + ',' +
                    urlObj.lat + ',' + urlObj.lon + ',' + urlObj.width + 'x' + urlObj.height + '@2x.png';

                urlParts.query = {}; // deleting it would cause errors in mw.Uri()
                if (urlObj.lang) {
                  urlParts.query.lang = urlObj.lang;
                }

                break;

            default:
                throw new Error('Unknown protocol ' + urlObj.type);
        }

        return this.formatUrl(urlParts, options);
    };

    /**
     * Parses the response from MW Api, throwing an error or logging warnings
     */
    parseMWApiResponse(data) {
        data = JSON.parse(data);
        if (data.error) {
            throw new Error('API error: ' + JSON.stringify(data.error));
        }
        if (data.warnings) {
            this.logger('API warnings: ' + JSON.stringify(data.warnings));
        }
        return data;
    };

    /**
     * For tabular and map data, extract necessary metadata from the original data
     */
    getMetaData(data) {
        return [{
            description: data.description,
            license_code: data.license.code,
            license_text: data.license.text,
            license_url: data.license.url,
            sources: data.sources
        }];
    }

    /**
     * Performs post-processing of the data requested by the graph's spec
     */
    parseResponse(data, type) {
        switch (type) {
            case 'wikiapi':
                data = this.parseMWApiResponse(data);
                break;
            case 'wikiraw':
                data = this.parseMWApiResponse(data);
                try {
                    data = data.query.pages[0].revisions[0].content;
                } catch (e) {
                    throw new Error('Page content not available\n' + JSON.stringify(data));
                }
                break;
            case 'wikidatasparql':
                data = JSON.parse(data);
                if (!data.results || !Array.isArray(data.results.bindings)) {
                    throw new Error('SPARQL query result does not have "results.bindings"');
                }
                data = data.results.bindings.map(function (row) {
                    let key, result = {};
                    for (key in row) {
                        if (row.hasOwnProperty(key)) {
                            result[key] = parseWikidataValue(row[key]);
                        }
                    }
                    return result;
                });
                break;
            case 'tabular':
                data = this.parseMWApiResponse(data).jsondata;
                const fields = data.schema.fields.map(function (v) {
                    return v.name;
                });
                data = {
                    meta: this.getMetaData(data),
                    fields: data.schema.fields,
                    data: data.data.map(v => {
                        let row = {}, i;
                        for (i = 0; i < fields.length; i++) {
                            // Need to copy nulls too -- Vega has no easy way to test for undefined
                            row[fields[i]] = v[i];
                        }
                        return row;
                    })
                }
                break;
            case 'map':
                data = this.parseMWApiResponse(data).jsondata;
                let metadata = this.getMetaData(data);
                metadata[0].zoom = data.zoom;
                metadata[0].latitude = data.latitude;
                metadata[0].longitude = data.longitude;
                data = {
                    meta: metadata,
                    data: data.data
                };
                break;
        }

        return data;
    };
}

module.exports = VegaWrapper2;
