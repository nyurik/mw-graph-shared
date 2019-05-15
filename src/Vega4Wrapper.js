/**
 * convert a uri object to a url string
 * @param {object} uri - An object that consists of the protocol, host, port, path, and parameters of an url
 * @return {string}
 */
function uriToUrl(uri) {
    let url = '';
    if(uri.type) url += uri.type + '://'; // whether use relative protocol
    if(uri.host) url += uri.host + (uri.port ? ':' + uri.port : '');
    if(url) url += '/'; // if url has protocol or host
    if(uri.path) url += uri.path.length > 0 && uri.path[0] === '/' ? uri.path.substring(1) : uri.path;

    // get the parameters of the URL, encoded into a string
    let copyUri = Object.assign({}, uri);
    ['type', 'host', 'port', 'path'].forEach(e => delete copyUri[e]);
    url += '?';
    for (let [key, value] of Object.entries(copyUri)) {
        url += key + '=' + encodeURI(value) + '&';
    }
    return url.substring(0, url.length-1);
}

class Vega4Wrapper {
    /**
     * Shared library to wrap around vega code
     * @param {Object} wrapperOpts Configuration options
     * @param {Object} wrapperOpts.loader Vega-loader object, used for overwriting
     * @param {Function} wrapperOpts.extend Vega-util's extend, similar to jquery's extend()
     * @param {boolean} wrapperOpts.isTrusted true if the graph spec can be trusted
     * @param {Object} wrapperOpts.domains allowed protocols and a list of their domains
     * @param {Object} wrapperOpts.domainMap domain remapping
     * @param {Function} wrapperOpts.logger
     * @param {Function} wrapperOpts.parseUrl
     * @param {Function} wrapperOpts.formatUrl
     * @param {string} [wrapperOpts.languageCode]
     * @constructor
     */
    constructor(wrapperOpts) {
        var self = this;
        self.vwProto = Object.create(require('./VegaWrapper.js').prototype);
        // Copy all options into the wrapper
        self.vwProto.objExtender = wrapperOpts.extend; 
        self.vwProto.objExtender(self.vwProto, wrapperOpts);
        self.vwProto.validators = {};

        self.vwProto.loader.sanitize = self.sanitize.bind(self);
        self.vwProto.loader.load = (uri, options) => {
            return self.sanitize(uri, options)
                .then(opt => {
                    var url = opt.href;
                    return self.vwProto.loader.http(url, options)
                        .then(txt => {
                            return self.vwProto.parseDataOrThrow(txt, options);
                        });
                });
        }

        // Prevent accidental use
        self.vwProto.loader.file = () => { throw new Error('Disabled'); };
    }

    /**
     * wrapper for VegaWrapper.sanitizeUrl method
     * @param {object} uri - An object that will be converted to an url string
     * @param {object} options - passed by the vega loader, and will add 'graphProtocol' param
     * @return {Promise} The sanitized uri is provided by the 'href' property. We never load file from local file system.
     */
    sanitize(uri, options) {
        var vwProto = this.vwProto;
        return new Promise(function(accept) {
            if(uri === null) {
                throw new Error("URI can't be null");
            }
            options.url = uriToUrl(uri);
            
            var result = {href: null, loadFile: false};
            result.href = vwProto.sanitizeUrl(options);
            
            //return
            accept(result);
        });
    }
}

module.exports = Vega4Wrapper;