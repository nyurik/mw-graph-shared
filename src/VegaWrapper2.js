const LITERAL_TYPES = new Set(['number', 'boolean', 'string']);

const makeValidator = require('domain-validator'),
      parseWikidataValue = require('wd-type-parser');

function validate(urlObj, name, min, max, isFloat) {
    let value = urlObj[name];
    if (value === undefined) {
        throw new Error(urlObj.type + ': parameter ' + name + ' is not set');
    }
    if (!(isFloat ? /^-?[0-9]+\.?[0-9]*$/ : /^-?[0-9]+$/).test(value)) {
        throw new Error(urlObj.type + ': parameter ' + name + ' is not a number');
    }
    value = isFloat ? parseFloat(value) : parseInt(value);
    if (value < min || value > max) {
        throw new Error(urlObj.type + ': parameter ' + name + ' is not valid');
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
        this.loader.load = (uri, options) => 
            this.sanitize(uri, options)
                .then(opt => this.loader.http(opt.href, options))
                .then(txt => this.parseResponse(txt, uri.type, options));

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
        return Promise.resolve({href: this.objToUrl(uri, options), loadFile: false});
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
    }

    /**
     * convert the urlObj to a url string
     * @param {object} urlObj an object consists of type and essential parameters
     * @param {object} options used to attach CORS infomation
     * @returns {string} a complete url
     */
    objToUrl(urlObj, options) {
        const host = urlObj.wiki ? urlObj.wiki : options.domain;
        const sanitizedHost = this.sanitizeHost(host);

        if (!sanitizedHost) {
            throw new Error('URL hostname is not whitelisted: ' + host);
        }
        const urlParts = {
            host: sanitizedHost.host,
            protocol: sanitizedHost.protocol,
            query: {}
        };

        switch(urlObj.type) {
            case 'wikiapi':
                // {type: “wikiapi”, params: {action:”...”, ...} [, wiki: “en.wikipedia.org”]}
                // Call to api.php - the *params* are converted into the url query string
                // use *wiki* to designate the host
                if(!urlObj.params || typeof urlObj.params !== 'object' || Array.isArray(urlObj.params)) {
                    throw new Error('wikiapi: "params" should be an object');
                }
                for(const k of Object.keys(urlObj.params)) {
                    const v = urlObj.params[k];
                    if(!LITERAL_TYPES.has(typeof v)) {
                        throw new Error('wikiapi: "params" value should be a literal (e.g. true, 123, "foo")');
                    } else if(v === true) { // replace with 1
                        urlObj.params[k] = 1;
                    } else if(v === false) { // remove item if value is false
                        delete urlObj.params[k];
                    }
                }
                Object.assign(urlParts.query, urlObj.params, {format: 'json', formatversion: '2'});
                urlParts.pathname = '/w/api.php';
                options.addCorsOrigin = true;
                break;

            case 'wikirest':
                // {type: “wikirest”, path: “/rest_v1/page/...” [, wiki: “en.wikipedia.org”]}
                // Call to RESTbase api - will add "/api" in front of *path* automatically
                // The /api/... path is safe for GET requests
                if(!urlObj.path || typeof urlObj.path !== 'string') {
                    throw new Error('wikirest: url path should be a non-empty string without the /api prefix');
                }
                urlParts.pathname = (urlObj.path.startsWith('/') ? '/api' : '/api/') + urlObj.path;
                break;

            case 'wikiraw':
                // {type: “wikiraw”, title: “MyPage” [, wiki: “en.wikipedia.org”]}
                // Get content of a wiki page
                // Uses mediawiki api, and extract the content after the request
                // Query value must be a valid MediaWiki title string, but we only ensure
                // there is no pipe symbol or \x1F, the rest is handled by the api.
                if (!urlObj.title || !/^[^|\x1F]+$/.test(urlObj.title)) {
                    throw new Error('wikiraw: invalid title' + JSON.stringify(urlObj));
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
                if (urlObj.type === 'map') {
                    if (!/^[^|\x1F]+\.map$/.test(urlObj.title)) {
                        throw new Error(`map: invalid title ${JSON.stringify(urlObj)}, can't contain pipe symbol, must end with .map`);
                    }
                } 
                else if(!/^[^|\x1F]+\.tab$/.test(urlObj.title)) {
                    throw new Error(`tabular: invalid title ${JSON.stringify(urlObj)}, can't contain pipe symbol, must end with .tab`);
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
                if (!urlObj.title || !/^[^|\x1F]+$/.test(urlObj.title)) {
                    throw new Error('wikifile: invalid title' + JSON.stringify(urlObj));
                }
                urlParts.pathname = '/wiki/Special:Redirect/file/' + urlObj.title;
                if(urlObj.width) {
                    validate(urlObj, 'width', 0, Infinity);
                    urlParts.query.width = urlObj.width;
                }
                if(urlObj.height) {
                    validate(urlObj, 'height', 0, Infinity);
                    urlParts.query.height = urlObj.height;
                }
                break;

            case 'wikidatasparql':
                // {type: “wikidatasparql”, query: "..."}
                // Runs a SPARQL query, converting it to
                // https://query.wikidata.org/bigdata/namespace/wdq/sparql?format=json&query=...
                this._overrideHostAndProtocol(urlParts, urlObj);
                if (!urlObj.query) {
                    throw new Error('wikidatasparql: missing query parameter');
                }
                if(typeof urlObj.query !== 'string') {
                    throw new Error('wikidatasparql: query should be a string');
                }
                urlParts.query = {query: urlObj.query};
                urlParts.pathname = '/bigdata/namespace/wdq/sparql';
                options.headers = Object.assign(options.headers || {}, {'Accept': 'application/sparql-results+json'});
                break;

            case 'geoshape':
            case 'geoline':
                // {type: “geoshape”, [ids: ["Q16","Q30"] | query:"..."] }
                // Get geoshapes data from OSM database by supplying Wikidata IDs
                // https://maps.wikimedia.org/shape?ids=Q16,Q30
                // 'geoline:' is an identical service, except that it returns lines instead of polygons
                this._overrideHostAndProtocol(urlParts, urlObj, 'geoshape');
                if (!urlObj.ids && !urlObj.query) {
                    throw new Error(urlObj.type + ' missing ids or query parameter in: ' + JSON.stringify(urlObj));
                }
                if(urlObj.ids) {
                    let ids = urlObj.ids;
                    if (typeof ids === 'string') {
                        // allow ids to be a string with a single wikidata ID (convert it to an array)
                        ids = [ids];
                    } else if (!Array.isArray(ids) || ids.length < 1 || ids.length > 1000) {
                        throw new Error(`ids must be an non-empty array of Wikidata IDs with no more than 1000 items`);
                    }
                    ids.forEach(val => {
                        if (!/^Q[1-9][0-9]{0,15}$/.test(val)) {
                            throw new Error(`Invalid Wikidata ID ${JSON.stringify(val)}`);
                        }
                    });
                    urlParts.query.ids = ids.join(',');
                } else if(urlObj.query) {
                    if(typeof urlObj.query !== 'string') {
                        throw new Error(urlObj.type + ': query should be a non-empty string\n' + JSON.stringify(urlObj));
                    }
                    urlParts.query.query = urlObj.query;
                } else {
                    throw new Error(urlObj.type + 'requires either ids or query parameter');
                }
                urlParts.pathname = '/' + urlObj.type;
                break;

            case 'mapsnapshot':
                // {type: “mapsnapshot”,  width:100, height:100, lat:10, lon:10, zoom:5 [, style:'osm', lang:’fr’]}
                // Converts it into a snapshot image request for Kartotherian:
                // https://maps.wikimedia.org/img/{style},{zoom},{lat},{lon},{width}x{height}[@{scale}x].{format}
                // (scale will be set to 2, and format to png)
                validate(urlObj, 'width', 1, 4096);
                validate(urlObj, 'height', 1, 4096);
                validate(urlObj, 'zoom', 0, 22);
                validate(urlObj, 'lat', -90, 90, true);
                validate(urlObj, 'lon', -180, 180, true);

                if (urlObj.style && !/^[-_0-9a-z]+$/.test(urlObj.style)) {
                    throw new Error('mapsnapshot: if style is given, it must be letters/numbers/dash/underscores only');
                }
                if (urlObj.lang && !/^[-_0-9a-zA-Z]+$/.test(urlObj.lang)) {
                    throw new Error('mapsnapshot: if lang is given, it must be letters/numbers/dash/underscores only');
                }

                // Uses the same configuration as geoshape service, so reuse settings
                this._overrideHostAndProtocol(urlParts, urlObj, 'geoshape');

                urlParts.pathname = `/img/${urlObj.style || 'osm-intl'},${urlObj.zoom},${urlObj.lat},${urlObj.lon},${urlObj.width}x${urlObj.height}@2x.png`;

                if (urlObj.lang) {
                    urlParts.query.lang = urlObj.lang;
                }

                break;

            default:
                throw new Error('Unknown type parameter ' + urlObj.type);
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
                data = data.results.bindings.map(row => {
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
                const fields = data.schema.fields.map(v => v.name);
                data = {
                    meta: this.getMetaData(data),
                    fields: data.schema.fields,
                    data: data.data.map(v => {
                        const row = {};
                        for (let i = 0; i < fields.length; i++) {
                            // Need to copy nulls too -- Vega has no easy way to test for undefined
                            row[fields[i]] = v[i];
                        }
                        return row;
                    })
                }
                break;
            case 'map':
                data = this.parseMWApiResponse(data).jsondata;
                const metadata = this.getMetaData(data);
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
