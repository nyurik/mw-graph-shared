'use strict';
/* global module */

var makeValidator = require('domain-validator');

module.exports = VegaWrapper;

/**
 * Shared library to wrap around vega code
 * @param {Object} load Vega loader object to use and override
 * @param {boolean} useXhr true if we should use XHR, false for node.js http loading
 * @param {boolean} isTrusted true if the graph spec can be trusted
 * @param {Object} domains allowed protocols and a list of their domains
 * @param {Object} domainMap domain remapping
 * @param {Function} logger
 * @param {Function} objExtender $.extend in browser, _.extend in NodeJs
 * @param {Function} parseUrl
 * @param {Function} formatUrl
 * @constructor
 */
function VegaWrapper(load, useXhr, isTrusted, domains, domainMap, logger, objExtender, parseUrl, formatUrl) {
    var self = this;
    self.isTrusted = isTrusted;
    self.domains = domains;
    self.domainMap = domainMap;
    self.logger = logger;
    self.objExtender = objExtender;
    self.parseUrl = parseUrl;
    self.formatUrl = formatUrl;
    self.validators = {};

    load.loader = function (opt, callback) {
        var error = callback || function (e) { throw e; }, url;

        try {
            url = self.sanitizeUrl(opt); // enable override
        } catch (err) {
            error(err);
            return;
        }

        // Process data response
        var cb = function (error, data) {
            return self.dataParser(error, data, opt, callback);
        };

        if (useXhr) {
            return load.xhr(url, opt, cb);
        } else {
            return load.http(url, opt, cb);
        }
    };

    load.sanitizeUrl = self.sanitizeUrl.bind(self);

    // Prevent accidental use
    load.file = function() { throw new Error('Disabled'); };
    if (useXhr) {
        load.http = load.file;
    } else {
        load.xhr = load.file;
    }
}

/**
 * Check if host was listed in the allowed domains, normalize it, and get correct protocol
 * @param {string} host
 * @returns {Object}
 */
VegaWrapper.prototype.sanitizeHost = function sanitizeHost(host) {
    // First, map the host
    host = (this.domainMap && this.domainMap[host]) || host;

    if (this.testHost('https', host)) {
        return {host: host, protocol: 'https'};
    } else if (this.testHost('http', host)) {
        return {host: host, protocol: 'http'};
    }
    return undefined;
};

/**
 * Test host against the list of allowed domains based on the protocol
 * @param {string} protocol
 * @param {string} host
 * @returns {boolean}
 */
VegaWrapper.prototype.testHost = function testHost(protocol, host) {
    if (!this.validators[protocol]) {
        if (this.domains[protocol]) {
            this.validators[protocol] = makeValidator(this.domains[protocol], protocol === 'https' || protocol === 'http');
        } else {
            return false;
        }
    }
    return this.validators[protocol].test(host);
};

/**this
 * Validate and update urlObj to be safe for client-side and server-side usage
 * @param {Object} opt passed by the vega loader. May be altered with optional "isApiCall" and "extractApiContent"
 * @returns {boolean} true on success
 */
VegaWrapper.prototype.sanitizeUrl = function sanitizeUrl(opt) {
    // In some cases we may receive a badly formed URL in a form   customprotocol:https://...
    opt.url = opt.url.replace(/^([a-z]+:)https?:\/\//, '$1//');

    var urlParts = this.parseUrl(opt);

    var sanitizedHost = this.sanitizeHost(urlParts.host);
    if (!sanitizedHost) {
        throw new Error('URL hostname is not whitelisted: ' + opt.url);
    }
    urlParts.host = sanitizedHost.host;
    if (!urlParts.protocol) {
        // Update protocol-relative URLs
        urlParts.protocol = sanitizedHost.protocol;
    }

    switch (urlParts.protocol) {
        case 'http':
        case 'https':
            if (!this.isTrusted) {
                throw new Error('HTTP and HTTPS protocols are not supported for untrusted graphs.\n' +
                    'Use wikiraw:, wikiapi:, wikirest:, wikirawupload:, and other protocols.\n' +
                    'See https://www.mediawiki.org/wiki/Extension:Graph#External_data');
            }
            // keep the original URL
            break;

        case 'wikiapi':
            // wikiapi:///?action=query&list=allpages
            // Call to api.php - ignores the path parameter, and only uses the query
            urlParts.query = this.objExtender(urlParts.query, {format: 'json', formatversion: '2'});
            urlParts.pathname = '/w/api.php';
            urlParts.protocol = sanitizedHost.protocol;
            opt.isApiCall = true;
            break;

        case 'wikirest':
            // wikirest:///api/rest_v1/page/...
            // Call to RESTbase api - requires the path to start with "/api/"
            // The /api/... path is safe for GET requests
            if (!/^\/api\//.test(urlParts.pathname)) {
                throw new Error('wikirest: protocol must begin with the /api/ prefix');
            }
            // keep urlParts.query
            // keep urlParts.pathname
            urlParts.protocol = sanitizedHost.protocol;
            break;

        case 'wikiraw':
            // wikiraw:///MyPage/data
            // Get raw content of a wiki page, where the path is the title
            // of the page with an additional leading '/' which gets removed.
            // Uses mediawiki api, and extract the content after the request
            // Query value must be a valid MediaWiki title string, but we only ensure
            // there is no pipe symbol, the rest is handlered by the api.
            urlParts.pathname = decodeURIComponent(urlParts.pathname)
            if (!/^\/[^|]+$/.test(urlParts.pathname)) {
                throw new Error('wikiraw: invalid title');
            }
            urlParts.query = {
                format: 'json',
                formatversion: '2',
                action: 'query',
                prop: 'revisions',
                rvprop: 'content',
                titles: urlParts.pathname.substring(1)
            };
            urlParts.pathname = '/w/api.php';
            urlParts.protocol = sanitizedHost.protocol;
            opt.isApiCall = true;
            opt.extractApiContent = true;
            break;

        case 'wikirawupload':
            // wikirawupload://upload.wikimedia.org/wikipedia/commons/3/3e/Einstein_1921.jpg
            // Get an image for the graph, e.g. from commons
            // This tag specifies any content from the uploads.* domain, without query params
            this._validateExternalService(urlParts, sanitizedHost, opt.url);
            urlParts.query = {};
            // keep urlParts.pathname;
            break;

        case 'wikidatasparql':
            // wikidatasparql:///?query=<QUERY>
            // Runs a SPARQL query, converting it to
            // https://query.wikidata.org/bigdata/namespace/wdq/sparql?format=json&query=...
            this._validateExternalService(urlParts, sanitizedHost, opt.url);
            if (!urlParts.query || !urlParts.query.query) {
                throw new Error('wikidatasparql: missing query parameter in: ' + opt.url);
            }
            urlParts.query = { format: 'json', query: urlParts.query.query };
            urlParts.pathname = '/bigdata/namespace/wdq/sparql';
            break;

        case 'geoshape':
            // geoshape:///?ids=Q16,Q30
            // Get geo shapes data from OSM database by supplying Wikidata IDs
            // https://maps.wikimedia.org/shape?ids=Q16,Q30
            this._validateExternalService(urlParts, sanitizedHost, opt.url);
            if (!urlParts.query || (!urlParts.query.ids && !urlParts.query.query)) {
                throw new Error('geoshape: missing ids or query parameter in: ' + opt.url);
            }
            // the query object is not modified
            urlParts.pathname = '/shape';
            break;

        default:
            throw new Error('Unknown protocol ' + opt.url);
    }
    return this.formatUrl(urlParts, opt);
};

VegaWrapper.prototype._validateExternalService = function _validateExternalService(urlParts, sanitizedHost, url) {
    var protocol = urlParts.protocol;
    if (!this.domains[protocol]) {
        throw new Error(protocol + ': protocol is disabled: ' + url);
    }
    if (urlParts.isRelativeHost) {
        urlParts.host = this.domains[protocol][0];
        urlParts.protocol = this.sanitizeHost(urlParts.host).protocol;
    } else {
        urlParts.protocol = sanitizedHost.protocol;
    }
    if (!this.testHost(protocol, urlParts.host)) {
        throw new Error(protocol + ': URL must either be relative (' + protocol + '///...), or use one of the allowed hosts: ' + url);
    }
};

/**
 * Performs post-processing of the data requested by the graph's spec
 */
VegaWrapper.prototype.dataParser = function dataParser(error, data, opt, callback) {
    if (error) {
        callback(error);
        return;
    }
    if (opt.isApiCall) {
        // This was an API call - check for errors
        var json = JSON.parse(data);
        if (json.error) {
            error = new Error('API error: ' + JSON.stringify(json.error));
            data = undefined;
        } else {
            if (json.warnings) {
                this.logger('API warnings: ' + JSON.stringify(json.warnings));
            }
            if (opt.extractApiContent) {
                try {
                    data = json.query.pages[0].revisions[0].content;
                } catch (e) {
                    data = undefined;
                    error = new Error('Page content not available ' + opt.url);
                }
            }
        }
    }
    callback(error, data);
};
