var makeValidator = require('domain-validator');

class Vega4Wrapper {
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
        var self = this;
        // Copy all options into the wrapper
        Object.assign(self, wrapperOpts);
        self.validators = {};

        self.loader.sanitize = self.sanitize.bind(self);
        self.loader.load = (uri, options) => {
            return self.sanitize(uri, options)
                .then(opt => {
                    var url = opt.href;
                    return self.loader.http(url, options)
                        .then(txt => {
                            return self.parseResponse(txt, uri.type, options);
                        });
                });
        }

        // Prevent accidental use
        self.loader.file = () => { throw new Error('Disabled'); };
    }

    /**
     * Validate and update urlObj to be safe for client-side and server-side usage
     * @param {object} uri - An object that will be converted into an url string
     * @param {object} options - passed by the vega loader
     * @return {Promise} The sanitized url is provided by the 'href' property. We never load file from local file system.
     */
    sanitize(uri, options) {
        var url = this.objToUrl(uri, options);
        return new Promise(function(accept) {
            var result = {href: url, loadFile: false};
            
            //return
            accept(result);
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
            var domains = this.domains[protocol];
            if (domains) {
                this.validators[protocol] = makeValidator(domains, protocol === 'https' || protocol === 'http');
            } else {
                return false;
            }
        }
        return this.validators[protocol].test(host);
    };
    
    /**
     * convert a uri object to a url string
     * @param {object} uri an object consists of type and essential parameters
     * @param {object} options used to attach CORS infomation
     * @returns {string} a complete url
     */
    objToUrl(uri, options) {
        var urlParts = {host: uri.host ? uri.host : options.domain},
            sanitizedHost = this.sanitizeHost(urlParts.host);

        if (!sanitizedHost) {
            throw new Error('URL hostname is not whitelisted: ' + urlParts.host);
        }
        urlParts.host = sanitizedHost.host;

        switch(uri.type) {
            case 'tabular':
            case 'map':
                // { type: 'tabular', path: 'Data.tab' [, lang: 'en'] }
                // { type: 'map', path: 'Data.map' [, lang: 'en'] }
                // Get content of a wiki page belonging to Data namespace, where the path 
                // is the title of the page with an additional leading '/' which gets 
                // removed. Uses mediawiki api, and extract the content after the request
                // Query value must be a valid MediaWiki title string, so we ensure there
                // is no pipe symbol and ends with .tab or .map
                if (!/^[^|]+\.(tab|map)$/.test(uri.path)) {
                    throw new Error(uri.type + ': invalid title');
                }
                urlParts.query = {
                    format: 'json',
                    formatversion: '2',
                    action: 'jsondata',
                    title: uri.path[0] === '/' ? uri.path.substring(1) : uri.path
                };
                if (uri.lang || this.languageCode) {
                    urlParts.query.uselang = uri.lang || this.languageCode;
                }

                urlParts.pathname = '/w/api.php';
                urlParts.protocol = sanitizedHost.protocol;
                options.addCorsOrigin = true;
                break;

            default:
                throw new Error('Unknown protocol ' + uri.type);
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
        var metadata = [{
            description: data.description,
            license_code: data.license.code,
            license_text: data.license.text,
            license_url: data.license.url,
            sources: data.sources
        }];
        return metadata;
    }

    /**
     * Performs post-processing of the data requested by the graph's spec
     */
    parseResponse(data, type) {
        switch (type) {
            case 'tabular':
                data = this.parseMWApiResponse(data).jsondata;
                var metadata = this.getMetaData(data);
                var fields = data.schema.fields.map(function (v) {
                    return v.name;
                });
                data = {
                    meta: metadata,
                    fields: data.schema.fields,
                    data: data.data.map(function (v) {
                        var row = {}, i;
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
                var metadata = this.getMetaData(data);
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

module.exports = Vega4Wrapper;