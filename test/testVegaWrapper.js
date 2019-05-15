'use strict';

var assert = require('assert'),
    _ = require('underscore'),
    util = require('util'),
    urllib = require('url'),
    VegaWrapper = require('../src/VegaWrapper'),
    Vega4Wrapper = require('../src/Vega4Wrapper');

describe('vegaWrapper', function() {

    /**
     * This is a copy of the vega2.js parseUrl code. If updated here, make sure to copy it there as well.
     * It is not easy to reuse it because current lib should be browser vs nodejs agnostic,
     * @param opt
     * @return {*}
     */
    function parseUrl(opt) {
        var url = opt.url;
        var isRelativeUrl = url[0] === '/' && url[1] === '/';
        if (isRelativeUrl) {
            // Workaround: urllib does not support relative URLs, add a temp protocol
            url = 'temp:' + url;
        }
        var urlParts = urllib.parse(url, true);
        if (isRelativeUrl) {
            delete urlParts.protocol;
        }
        // reduce confusion, only keep expected values
        delete urlParts.hostname;
        delete urlParts.path;
        delete urlParts.href;
        delete urlParts.port;
        delete urlParts.search;
        if (!urlParts.host || urlParts.host === '') {
            urlParts.host = opt.domain;
            // for some protocols, default host name is resolved differently
            // this value is ignored by the urllib.format()
            urlParts.isRelativeHost = true;
        }

        return urlParts;
    }

    function expectError(testFunc, msg, errFuncNames) {
        var error, result;
        try {
            result = testFunc();
        } catch (err) {
            error = err;
        }

        if (!error) {
            assert(false, util.format('%j was expected to cause an error in functions %j, but returned %j',
                msg, errFuncNames, result));
        }

        if (error.stack.split('\n').map(function (v) {
                return v.trim().split(' ');
            }).filter(function (v) {
                return v[0] === 'at';
            })[0][1] in errFuncNames
        ) {
            // If first stack line (except the possibly multiline message) is not expected function, throw
            error.message = '"' + msg + '" caused an error:\n' + error.message;
            throw error;
        }
    }

    var domains = {
        http: ['nonsec.org'],
        https: ['sec.org'],
        wikiapi: ['wikiapi.nonsec.org', 'wikiapi.sec.org'],
        wikirest: ['wikirest.nonsec.org', 'wikirest.sec.org'],
        wikiraw: ['wikiraw.nonsec.org', 'wikiraw.sec.org'],
        wikirawupload: ['wikirawupload.nonsec.org', 'wikirawupload.sec.org'],
        wikidatasparql: ['wikidatasparql.nonsec.org', 'wikidatasparql.sec.org'],
        geoshape: ['maps.nonsec.org', 'maps.sec.org']
    };
    var domainMap = {
        'nonsec': 'nonsec.org',
        'sec': 'sec.org'
    };

    function createWrapper(useXhr, isTrusted) {
        var datalib = {
            extend: _.extend,
            load: {}
        };
        return new VegaWrapper({
            datalib: datalib,
            useXhr: useXhr,
            isTrusted: isTrusted,
            domains: domains,
            domainMap: domainMap,
            logger: function (msg) { throw new Error(msg); },
            parseUrl: parseUrl,
            formatUrl: urllib.format,
            languageCode: 'en'
        });
    }

    it('sanitizeUrl - unsafe', function () {
        var wrapper = createWrapper(true, true),
            pass = function (url, expected) {
                assert.equal(wrapper.sanitizeUrl({url: url, domain: 'domain.sec.org'}), expected, url)
            },
            fail = function (url) {
                expectError(function () {
                    return wrapper.sanitizeUrl({url: url, domain: 'domain.sec.org'});
                }, url, ['VegaWrapper.sanitizeUrl']);
            };

        fail('nope://sec.org');
        fail('nope://sec');

        pass('', 'https://domain.sec.org');
        pass('blah', 'https://domain.sec.org/blah');
        pass('http://sec.org', 'http://sec.org/');
        pass('http://sec.org/blah?test=1', 'http://sec.org/blah?test=1');
        pass('http://any.sec.org', 'http://any.sec.org/');
        pass('http://any.sec.org/blah?test=1', 'http://any.sec.org/blah?test=1');
        pass('http://sec', 'http://sec.org/');
        pass('http://sec/blah?test=1', 'http://sec.org/blah?test=1');

    });

    it('sanitizeUrl - safe', function () {
        var wrapper = createWrapper(true, false),
            pass = function (url, expected, addCorsOrigin) {
                var opt = {url: url, domain: 'domain.sec.org'};
                assert.equal(wrapper.sanitizeUrl(opt), expected, url);
                assert.equal(opt.addCorsOrigin, addCorsOrigin, 'addCorsOrigin');
            },
            passWithCors = function (url, expected) {
                return pass(url, expected, true);
            },
            fail = function (url) {
                expectError(function () {
                    return wrapper.sanitizeUrl({url: url, domain: 'domain.sec.org'});
                }, url, ['VegaWrapper.sanitizeUrl', 'VegaWrapper._validateExternalService']);
            };

        fail('');
        fail('blah');
        fail('nope://sec.org');
        fail('nope://sec');
        fail('https://sec.org');
        fail('https://sec');

        // wikiapi allows sub-domains
        passWithCors('wikiapi://sec.org?a=1', 'https://sec.org/w/api.php?a=1&format=json&formatversion=2');
        passWithCors('wikiapi://wikiapi.sec.org?a=1', 'https://wikiapi.sec.org/w/api.php?a=1&format=json&formatversion=2');
        passWithCors('wikiapi://sec?a=1', 'https://sec.org/w/api.php?a=1&format=json&formatversion=2');
        passWithCors('wikiapi://nonsec.org?a=1', 'http://nonsec.org/w/api.php?a=1&format=json&formatversion=2');
        passWithCors('wikiapi://wikiapi.nonsec.org?a=1', 'http://wikiapi.nonsec.org/w/api.php?a=1&format=json&formatversion=2');
        passWithCors('wikiapi://nonsec?a=1', 'http://nonsec.org/w/api.php?a=1&format=json&formatversion=2');

        // wikirest allows sub-domains, requires path to begin with "/api/"
        fail('wikirest://sec.org');
        pass('wikirest:///api/abc', 'https://domain.sec.org/api/abc');
        pass('wikirest://sec.org/api/abc', 'https://sec.org/api/abc');
        pass('wikirest://sec/api/abc', 'https://sec.org/api/abc');
        pass('wikirest://wikirest.sec.org/api/abc', 'https://wikirest.sec.org/api/abc');
        pass('wikirest://wikirest.nonsec.org/api/abc', 'http://wikirest.nonsec.org/api/abc');

        // wikiraw allows sub-domains
        fail('wikiraw://sec.org');
        fail('wikiraw://sec.org/');
        fail('wikiraw://sec.org/?a=10');
        fail('wikiraw://asec.org/aaa');
        fail('wikiraw:///abc|xyz');
        fail('wikiraw://sec.org/abc|xyz');
        passWithCors('wikiraw:///abc', 'https://domain.sec.org/w/api.php?format=json&formatversion=2&action=query&prop=revisions&rvprop=content&titles=abc');
        passWithCors('wikiraw:///abc/xyz', 'https://domain.sec.org/w/api.php?format=json&formatversion=2&action=query&prop=revisions&rvprop=content&titles=abc%2Fxyz');
        passWithCors('wikiraw://sec.org/aaa', 'https://sec.org/w/api.php?format=json&formatversion=2&action=query&prop=revisions&rvprop=content&titles=aaa');
        passWithCors('wikiraw://sec.org/aaa?a=10', 'https://sec.org/w/api.php?format=json&formatversion=2&action=query&prop=revisions&rvprop=content&titles=aaa');
        passWithCors('wikiraw://sec.org/abc/def', 'https://sec.org/w/api.php?format=json&formatversion=2&action=query&prop=revisions&rvprop=content&titles=abc%2Fdef');
        passWithCors('wikiraw://sec/aaa', 'https://sec.org/w/api.php?format=json&formatversion=2&action=query&prop=revisions&rvprop=content&titles=aaa');
        passWithCors('wikiraw://sec/abc/def', 'https://sec.org/w/api.php?format=json&formatversion=2&action=query&prop=revisions&rvprop=content&titles=abc%2Fdef');
        passWithCors('wikiraw://wikiraw.sec.org/abc', 'https://wikiraw.sec.org/w/api.php?format=json&formatversion=2&action=query&prop=revisions&rvprop=content&titles=abc');

        fail('wikirawupload://sec.org');
        fail('wikirawupload://sec.org/');
        fail('wikirawupload://sec.org/a');
        fail('wikirawupload://sec.org/?a=10');
        fail('wikirawupload://asec.org/aaa');
        fail('wikirawupload://asec.org/aaa');
        fail('wikirawupload://asec.org/aaa');
        pass('wikirawupload:///aaa', 'http://wikirawupload.nonsec.org/aaa');
        pass('wikirawupload:///aaa/bbb', 'http://wikirawupload.nonsec.org/aaa/bbb');
        pass('wikirawupload:///aaa?a=1', 'http://wikirawupload.nonsec.org/aaa');
        pass('wikirawupload://wikirawupload.nonsec.org/aaa', 'http://wikirawupload.nonsec.org/aaa');
        fail('wikirawupload://blah.nonsec.org/aaa');
        fail('wikirawupload://a.wikirawupload.nonsec.org/aaa');

        fail('wikidatasparql://sec.org');
        fail('wikidatasparql://sec.org/');
        fail('wikidatasparql://sec.org/a');
        fail('wikidatasparql://sec.org/?a=10');
        fail('wikidatasparql://asec.org/aaa');
        fail('wikidatasparql://asec.org/aaa');
        fail('wikidatasparql://asec.org/aaa');
        fail('wikidatasparql:///aaa');
        fail('wikidatasparql:///?aquery=1');
        pass('wikidatasparql:///?query=1', 'http://wikidatasparql.nonsec.org/bigdata/namespace/wdq/sparql?query=1');
        pass('wikidatasparql://wikidatasparql.sec.org/?query=1', 'https://wikidatasparql.sec.org/bigdata/namespace/wdq/sparql?query=1');
        pass('wikidatasparql://wikidatasparql.sec.org/?query=1&blah=2', 'https://wikidatasparql.sec.org/bigdata/namespace/wdq/sparql?query=1');

        fail('geoshape://sec.org');
        fail('geoshape://sec.org/');
        fail('geoshape://sec.org/a');
        fail('geoshape://sec.org/?a=10');
        fail('geoshape://asec.org/aaa');
        fail('geoshape://asec.org/aaa');
        fail('geoshape://asec.org/aaa');
        fail('geoshape:///aaa');
        fail('geoshape:///?aquery=1');
        pass('geoshape:///?ids=1', 'http://maps.nonsec.org/geoshape?ids=1');
        pass('geoshape://maps.sec.org/?ids=a1,b4', 'https://maps.sec.org/geoshape?ids=a1%2Cb4');

        fail('geoline://sec.org');
        fail('geoline://sec.org/');
        fail('geoline://sec.org/a');
        fail('geoline://sec.org/?a=10');
        fail('geoline://asec.org/aaa');
        fail('geoline://asec.org/aaa');
        fail('geoline://asec.org/aaa');
        fail('geoline:///aaa');
        fail('geoline:///?aquery=1');
        pass('geoline:///?ids=1', 'http://maps.nonsec.org/geoline?ids=1');
        pass('geoline://maps.sec.org/?ids=a1,b4', 'https://maps.sec.org/geoline?ids=a1%2Cb4');

        pass('wikifile:///Einstein_1921.jpg', 'https://domain.sec.org/wiki/Special:Redirect/file/Einstein_1921.jpg');
        pass('wikifile:///Einstein_1921.jpg?width=10', 'https://domain.sec.org/wiki/Special:Redirect/file/Einstein_1921.jpg?width=10');
        pass('wikifile://sec.org/Einstein_1921.jpg', 'https://sec.org/wiki/Special:Redirect/file/Einstein_1921.jpg');

        fail('mapsnapshot://sec.org');
        fail('mapsnapshot://sec.org/');
        fail('mapsnapshot:///?width=100');
        fail('mapsnapshot:///?width=100&height=100&lat=10&lon=10&zoom=5&style=@4');
        fail('mapsnapshot:///?width=100&height=100&lat=10&lon=10&zoom=5&style=a$b');
        fail('mapsnapshot:///?width=100&height=100&lat=10&lon=10&zoom=5&lang=a$b');
        pass('mapsnapshot:///?width=100&height=100&lat=10&lon=10&zoom=5', 'http://maps.nonsec.org/img/osm-intl,5,10,10,100x100@2x.png');
        pass('mapsnapshot:///?width=100&height=100&lat=10&lon=10&zoom=5&style=osm', 'http://maps.nonsec.org/img/osm,5,10,10,100x100@2x.png');
        pass('mapsnapshot:///?width=100&height=100&lat=10&lon=10&zoom=5&style=osm&lang=local', 'http://maps.nonsec.org/img/osm,5,10,10,100x100@2x.png?lang=local');

        fail('tabular://sec.org');
        fail('tabular://sec.org/');
        fail('tabular://sec.org/?a=10');
        fail('tabular://asec.org/aaa');
        fail('tabular:///abc|xyz');
        fail('tabular://sec.org/abc|xyz');
        passWithCors('tabular:///abc', 'https://domain.sec.org/w/api.php?format=json&formatversion=2&action=jsondata&title=abc&uselang=en');
        passWithCors('tabular:///abc/xyz', 'https://domain.sec.org/w/api.php?format=json&formatversion=2&action=jsondata&title=abc%2Fxyz&uselang=en');
        passWithCors('tabular://sec.org/aaa', 'https://sec.org/w/api.php?format=json&formatversion=2&action=jsondata&title=aaa&uselang=en');
        passWithCors('tabular://sec.org/aaa?a=10', 'https://sec.org/w/api.php?format=json&formatversion=2&action=jsondata&title=aaa&uselang=en');
        passWithCors('tabular://sec.org/abc/def', 'https://sec.org/w/api.php?format=json&formatversion=2&action=jsondata&title=abc%2Fdef&uselang=en');
        passWithCors('tabular://sec/aaa', 'https://sec.org/w/api.php?format=json&formatversion=2&action=jsondata&title=aaa&uselang=en');
        passWithCors('tabular://sec/abc/def', 'https://sec.org/w/api.php?format=json&formatversion=2&action=jsondata&title=abc%2Fdef&uselang=en');
        passWithCors('tabular://wikiraw.sec.org/abc', 'https://wikiraw.sec.org/w/api.php?format=json&formatversion=2&action=jsondata&title=abc&uselang=en');

        fail('map://sec.org');
        fail('map://sec.org/');
        fail('map://sec.org/?a=10');
        fail('map://asec.org/aaa');
        fail('map:///abc|xyz');
        fail('map://sec.org/abc|xyz');
        passWithCors('map:///abc', 'https://domain.sec.org/w/api.php?format=json&formatversion=2&action=jsondata&title=abc&uselang=en');
        passWithCors('map:///abc/xyz', 'https://domain.sec.org/w/api.php?format=json&formatversion=2&action=jsondata&title=abc%2Fxyz&uselang=en');
        passWithCors('map://sec.org/aaa', 'https://sec.org/w/api.php?format=json&formatversion=2&action=jsondata&title=aaa&uselang=en');
        passWithCors('map://sec.org/aaa?a=10', 'https://sec.org/w/api.php?format=json&formatversion=2&action=jsondata&title=aaa&uselang=en');
        passWithCors('map://sec.org/abc/def', 'https://sec.org/w/api.php?format=json&formatversion=2&action=jsondata&title=abc%2Fdef&uselang=en');
        passWithCors('map://sec/aaa', 'https://sec.org/w/api.php?format=json&formatversion=2&action=jsondata&title=aaa&uselang=en');
        passWithCors('map://sec/abc/def', 'https://sec.org/w/api.php?format=json&formatversion=2&action=jsondata&title=abc%2Fdef&uselang=en');
        passWithCors('map://wikiraw.sec.org/abc', 'https://wikiraw.sec.org/w/api.php?format=json&formatversion=2&action=jsondata&title=abc&uselang=en');
    });

    it('sanitizeUrl for type=open', function () {
        var wrapper = createWrapper(true, false),
            pass = function (url, expected) {
                assert.equal(wrapper.sanitizeUrl({url: url, type: 'open', domain: 'domain.sec.org'}), expected, url)
            },
            fail = function (url) {
                expectError(function () {
                    return wrapper.sanitizeUrl({url: url, type: 'open', domain: 'domain.sec.org'});
                }, url, ['VegaWrapper.sanitizeUrl', 'VegaWrapper._validateExternalService']);
            };

        fail('wikiapi://sec.org?a=1');
        fail('wikirest:///api/abc');
        fail('///My%20page?foo=1');

        pass('wikititle:///My%20page', 'https://domain.sec.org/wiki/My_page');
        pass('///My%20page', 'https://domain.sec.org/wiki/My_page');
        pass('wikititle://sec.org/My%20page', 'https://sec.org/wiki/My_page');
        pass('//my.sec.org/My%20page', 'https://my.sec.org/wiki/My_page');

        // This is not a valid title, but it will get validated on the MW side
        pass('////My%20page', 'https://domain.sec.org/wiki/%2FMy_page');

        pass('http:///wiki/Http%20page', 'https://domain.sec.org/wiki/Http_page');
        pass('https:///wiki/Http%20page', 'https://domain.sec.org/wiki/Http_page');
        pass('http://my.sec.org/wiki/Http%20page', 'https://my.sec.org/wiki/Http_page');
        pass('https://my.sec.org/wiki/Http%20page', 'https://my.sec.org/wiki/Http_page');

        fail('http:///Http%20page');
        fail('https:///w/Http%20page');
        fail('https:///wiki/Http%20page?a=1');
    });

    it('dataParser', function () {
            var wrapper = createWrapper(),
                pass = function (expected, data, graphProtocol, dontEncode) {
                    assert.deepStrictEqual(
                        wrapper.parseDataOrThrow(
                            dontEncode ? data : JSON.stringify(data),
                            {graphProtocol: graphProtocol}),
                        expected)
                },
                fail = function (data, graphProtocol) {
                    expectError(function () {
                        return wrapper.parseDataOrThrow(
                            dontEncode ? data : JSON.stringify(data),
                            {graphProtocol: graphProtocol});
                    }, graphProtocol, ['VegaWrapper.parseDataOrThrow']);
                };

            fail(undefined, undefined, new Error());

            pass(1, 1, 'test:', true);

            fail({error: 'blah'}, 'wikiapi:');
            pass({blah: 1}, {blah: 1}, 'wikiapi:');

            fail({error: 'blah'}, 'wikiraw:');
            fail({blah: 1}, 'wikiraw:');
            pass('blah', {query: {pages: [{revisions: [{content: 'blah'}]}]}}, 'wikiraw:');

            fail({error: 'blah'}, 'wikidatasparql:');
            fail({blah: 1}, 'wikidatasparql:');
            fail({results: false}, 'wikidatasparql:');
            fail({results: {bindings: false}}, 'wikidatasparql:');
            pass([], {results: {bindings: []}}, 'wikidatasparql:');
            pass([{int: 42, float: 42.5, geo: [42, 144.5]}, {uri: 'Q42'}], {
                results: {
                    bindings: [{
                        int: {
                            type: 'literal',
                            'datatype': 'http://www.w3.org/2001/XMLSchema#int',
                            value: '42'
                        },
                        float: {
                            type: 'literal',
                            'datatype': 'http://www.w3.org/2001/XMLSchema#float',
                            value: '42.5'
                        },
                        geo: {
                            type: 'literal',
                            'datatype': 'http://www.opengis.net/ont/geosparql#wktLiteral',
                            value: 'Point(42 144.5)'
                        }
                    }, {
                        uri: {
                            type: 'uri',
                            value: 'http://www.wikidata.org/entity/Q42'
                        }
                    }]
                }
            }, 'wikidatasparql:');

            pass({
                    meta: [{
                        description: 'desc',
                        license_code: 'CC0-1.0+',
                        license_text: 'abc',
                        license_url: 'URL',
                        sources: 'src'
                    }],
                    fields: [{name: 'fld1'}],
                    data: [{fld1: 42}]
                },
                {
                    jsondata: {
                        description: 'desc',
                        sources: 'src',
                        license: {code: 'CC0-1.0+', text: 'abc', url: 'URL'},
                        schema: {fields: [{name: 'fld1'}]},
                        data: [[42]]
                    },
                }, 'tabular:');

            pass({
                    meta: [{
                        description: 'desc',
                        license_code: 'CC0-1.0+',
                        license_text: 'abc',
                        license_url: 'URL',
                        sources: 'src',
                        longitude: 10,
                        latitude: 20,
                        zoom: 3,
                    }],
                    data: "map"
                },
                {
                    jsondata: {
                        description: 'desc',
                        sources: 'src',
                        license: {code: 'CC0-1.0+', text: 'abc', url: 'URL'},
                        longitude: 10,
                        latitude: 20,
                        zoom: 3,
                        data: "map"
                    },
                }, 'map:');
        }
    );

});

describe('vega4Wrapper', function() {
    /**
     * This is a copy of the vega2.js parseUrl code. If updated here, make sure to copy it there as well.
     * It is not easy to reuse it because current lib should be browser vs nodejs agnostic,
     * @param opt
     * @return {*}
     */
    function parseUrl(opt) {
        var url = opt.url;
        var isRelativeUrl = url[0] === '/' && url[1] === '/';
        if (isRelativeUrl) {
            // Workaround: urllib does not support relative URLs, add a temp protocol
            url = 'temp:' + url;
        }
        var urlParts = urllib.parse(url, true);
        if (isRelativeUrl) {
            delete urlParts.protocol;
        }
        // reduce confusion, only keep expected values
        delete urlParts.hostname;
        delete urlParts.path;
        delete urlParts.href;
        delete urlParts.port;
        delete urlParts.search;
        if (!urlParts.host || urlParts.host === '') {
            urlParts.host = opt.domain;
            // for some protocols, default host name is resolved differently
            // this value is ignored by the urllib.format()
            urlParts.isRelativeHost = true;
        }

        return urlParts;
    }

    async function expectError(testFunc, msg, errFuncNames) {
        var error, result;
        msg = JSON.stringify(msg);
        try {
            result = await testFunc();
        } catch (err) {
            error = err;
        }

        if (!error) {
            assert(false, util.format('%j was expected to cause an error in functions %j, but returned %j',
                msg, errFuncNames, result));
        }

        if (error.stack.split('\n').map(function (v) {
                return v.trim().split(' ');
            }).filter(function (v) {
                return v[0] === 'at';
            })[0][1] in errFuncNames
        ) {
            // If first stack line (except the possibly multiline message) is not expected function, throw
            error.message = '"' + msg + '" caused an error:\n' + error.message;
            throw error;
        }
    }

    var domains = {
        http: ['nonsec.org'],
        https: ['sec.org'],
        wikiapi: ['wikiapi.nonsec.org', 'wikiapi.sec.org'],
        wikirest: ['wikirest.nonsec.org', 'wikirest.sec.org'],
        wikiraw: ['wikiraw.nonsec.org', 'wikiraw.sec.org'],
        wikirawupload: ['wikirawupload.nonsec.org', 'wikirawupload.sec.org'],
        wikidatasparql: ['wikidatasparql.nonsec.org', 'wikidatasparql.sec.org'],
        geoshape: ['maps.nonsec.org', 'maps.sec.org']
    };
    var domainMap = {
        'nonsec': 'nonsec.org',
        'sec': 'sec.org'
    };

    function createWrapper(isTrusted) {
        return new Vega4Wrapper({
            loader: {},
            extend: _.extend,
            isTrusted: isTrusted,
            domains: domains,
            domainMap: domainMap,
            logger: function (msg) { throw new Error(msg); },
            parseUrl: parseUrl,
            formatUrl: urllib.format,
            languageCode: 'en'
        });
    }

    it('sanitize - unsafe', async function () {
        var wrapper = createWrapper(true),
            pass = async function (url, expected) {
                const result = await wrapper.sanitize(url, { domain: 'domain.sec.org' });
                assert.equal(result.href, expected, JSON.stringify(url));
            },
            fail = async function (url) {
                await expectError(async function () {
                    return await wrapper.sanitize(url, {domain: 'domain.sec.org'});
                }, url, ['Vega4Wrapper.sanitize']);
            };

        await fail({ type: 'nope', host: 'sec.org' });
        await fail({ type: 'nope', host: 'sec' });

        await pass({}, 'https://domain.sec.org');
        await pass({ path: 'blah' }, 'https://domain.sec.org/blah');
        await pass({ path: '/blah' }, 'https://domain.sec.org/blah');
        await pass({ type: 'http', host: 'sec.org' }, 'http://sec.org/');
        await pass({ type: 'http', host: 'sec.org', path: 'blah', test: 1}, 'http://sec.org/blah?test=1');
        await pass({ type: 'http', host: 'any.sec.org' }, 'http://any.sec.org/');
        await pass({ type: 'http', host: 'any.sec.org', path: 'blah', test: 1}, 'http://any.sec.org/blah?test=1');
        await pass({ type: 'http', host: 'sec' }, 'http://sec.org/');
        await pass({ type: 'http', host: 'sec', path: 'blah', test: 1}, 'http://sec.org/blah?test=1');

    });

    it('sanitize - safe', async function () {
        var wrapper = createWrapper(false),
            pass = async function (url, expected, addCorsOrigin) {
                var opt = {domain: 'domain.sec.org'};
                const result = await wrapper.sanitize(url, opt);
                assert.equal(result.href, expected, JSON.stringify(url));
                assert.equal(opt.addCorsOrigin, addCorsOrigin, 'addCorsOrigin');
            },
            passWithCors = async function (url, expected) {
                await pass(url, expected, true);
            },
            fail = async function (url) {
                await expectError(async function () {
                    return await wrapper.sanitize(url, {domain: 'domain.sec.org'});
                }, url, ['Vega4Wrapper.sanitize', 'VegaWrapper._validateExternalService']);
            };

        await fail({});
        await fail({ path: 'blah' });
        await fail({ type: 'nope', host: 'sec.org' });
        await fail({ type: 'nope', host: 'sec' });
        await fail({ type: 'https', host: 'sec.org' });
        await fail({ type: 'https', host: 'sec' });

        // wikiapi allows sub-domains
        await passWithCors({type:'wikiapi', host:'sec.org', a:'1'}, 'https://sec.org/w/api.php?a=1&format=json&formatversion=2');
        await passWithCors({type:'wikiapi', host:'wikiapi.sec.org', a:'1'}, 'https://wikiapi.sec.org/w/api.php?a=1&format=json&formatversion=2');
        await passWithCors({type:'wikiapi', host:'sec', a:'1'}, 'https://sec.org/w/api.php?a=1&format=json&formatversion=2');
        await passWithCors({type:'wikiapi', host:'nonsec.org', a:'1'}, 'http://nonsec.org/w/api.php?a=1&format=json&formatversion=2');
        await passWithCors({type:'wikiapi', host:'wikiapi.nonsec.org', a:'1'}, 'http://wikiapi.nonsec.org/w/api.php?a=1&format=json&formatversion=2');
        await passWithCors({type:'wikiapi', host:'nonsec', a:'1'}, 'http://nonsec.org/w/api.php?a=1&format=json&formatversion=2');

        // wikirest allows sub-domains, requires path to begin with "/api/"
        await fail({type:'wikirest', host:'sec.org'});
        await pass({type:'wikirest', path:'/api/abc'}, 'https://domain.sec.org/api/abc');
        await pass({type:'wikirest', host:'sec.org', path:'/api/abc'}, 'https://sec.org/api/abc');
        await pass({type:'wikirest', host:'sec', path:'/api/abc'}, 'https://sec.org/api/abc');
        await pass({type:'wikirest', host:'wikirest.sec.org', path:'/api/abc'}, 'https://wikirest.sec.org/api/abc');
        await pass({type:'wikirest', host:'wikirest.nonsec.org', path:'/api/abc'}, 'http://wikirest.nonsec.org/api/abc');

        // wikiraw allows sub-domains
        await fail({type:'wikiraw', host:'sec.org'});
        await fail({type:'wikiraw', host:'sec.org', a:10});
        await fail({type:'wikiraw', host:'asec.org', path:'aaa'});
        await fail({type:'wikiraw', path:'abc|xyz'});
        await fail({type:'wikiraw', path:'/abc|xyz'});
        await fail({type:'wikiraw', host:'sec.org', path:'abc|xyz'});
        await passWithCors({type:'wikiraw', path:'abc'}, 'https://domain.sec.org/w/api.php?format=json&formatversion=2&action=query&prop=revisions&rvprop=content&titles=abc');
        await passWithCors({type:'wikiraw', path:'/abc'}, 'https://domain.sec.org/w/api.php?format=json&formatversion=2&action=query&prop=revisions&rvprop=content&titles=abc');
        await passWithCors({type:'wikiraw', path:'abc/xyz'}, 'https://domain.sec.org/w/api.php?format=json&formatversion=2&action=query&prop=revisions&rvprop=content&titles=abc%2Fxyz');
        await passWithCors({type:'wikiraw', host:'sec.org', path:'aaa'}, 'https://sec.org/w/api.php?format=json&formatversion=2&action=query&prop=revisions&rvprop=content&titles=aaa');
        await passWithCors({type:'wikiraw', host:'sec.org', path:'aaa', a:10}, 'https://sec.org/w/api.php?format=json&formatversion=2&action=query&prop=revisions&rvprop=content&titles=aaa');
        await passWithCors({type:'wikiraw', host:'sec.org', path:'abc/def'}, 'https://sec.org/w/api.php?format=json&formatversion=2&action=query&prop=revisions&rvprop=content&titles=abc%2Fdef');
        await passWithCors({type:'wikiraw', host:'sec', path:'aaa'}, 'https://sec.org/w/api.php?format=json&formatversion=2&action=query&prop=revisions&rvprop=content&titles=aaa');
        await passWithCors({type:'wikiraw', host:'sec', path:'abc/def'}, 'https://sec.org/w/api.php?format=json&formatversion=2&action=query&prop=revisions&rvprop=content&titles=abc%2Fdef');
        await passWithCors({type:'wikiraw', host:'wikiraw.sec.org', path:'abc'}, 'https://wikiraw.sec.org/w/api.php?format=json&formatversion=2&action=query&prop=revisions&rvprop=content&titles=abc');

        await fail({type:'wikirawupload', host:'sec.org'});
        await fail({type:'wikirawupload', host:'sec.org', path: 'a'});
        await fail({type:'wikirawupload', host:'sec.org', a:10});
        await fail({type:'wikirawupload', host:'asec.org', path: 'aaa'});
        await pass({type:'wikirawupload', path: 'aaa'}, 'http://wikirawupload.nonsec.org/aaa');
        await pass({type:'wikirawupload', path: 'aaa/bbb'}, 'http://wikirawupload.nonsec.org/aaa/bbb');
        await pass({type:'wikirawupload', path: 'aaa', a:1}, 'http://wikirawupload.nonsec.org/aaa');
        await pass({type:'wikirawupload', host:'wikirawupload.nonsec.org', path: 'aaa'}, 'http://wikirawupload.nonsec.org/aaa');
        await fail({type:'wikirawupload', host:'blah.nonsec.org', path: 'aaa'});
        await fail({type:'wikirawupload', host:'a.wikirawupload.nonsec.org', path: 'aaa'});

        await fail({type:'wikidatasparql', host:'sec.org'});
        await fail({type:'wikidatasparql', host:'sec.org', path:'a'});
        await fail({type:'wikidatasparql', host:'sec.org', a:10});
        await fail({type:'wikidatasparql', host:'asec.org', path:'aaa'});
        await fail({type:'wikidatasparql', host:'asec.org', query:1});
        await fail({type:'wikidatasparql', path:'aaa'});
        await fail({type:'wikidatasparql', path:'aaa', aquery:1});
        await fail({type:'wikidatasparql', aquery:1});
        await pass({type:'wikidatasparql', query:1}, 'http://wikidatasparql.nonsec.org/bigdata/namespace/wdq/sparql?query=1');
        await pass({type:'wikidatasparql', path:'aaa', query:1}, 'http://wikidatasparql.nonsec.org/bigdata/namespace/wdq/sparql?query=1');
        await pass({type:'wikidatasparql', host:'wikidatasparql.sec.org', query:1}, 'https://wikidatasparql.sec.org/bigdata/namespace/wdq/sparql?query=1');
        await pass({type:'wikidatasparql', host:'wikidatasparql.sec.org', query:1, blah:2}, 'https://wikidatasparql.sec.org/bigdata/namespace/wdq/sparql?query=1');

        await fail({type:'geoshape', host:'sec.org'});
        await fail({type:'geoshape', host:'sec.org', path:'a'});
        await fail({type:'geoshape', host:'sec.org', path:'/a'});
        await fail({type:'geoshape', host:'sec.org', a:10});
        await fail({type:'geoshape', host:'asec.org', path:'aaa'});
        await fail({type:'geoshape', path:'aaa'});
        await fail({type:'geoshape', aquery:1});
        await pass({type:'geoshape', ids:1}, 'http://maps.nonsec.org/geoshape?ids=1');
        await pass({type:'geoshape', host:'maps.sec.org', ids:'a1,b4'}, 'https://maps.sec.org/geoshape?ids=a1%2Cb4');

        await fail({type:'geoline', host:'sec.org'});
        await fail({type:'geoline', host:'sec.org', path:'a'});
        await fail({type:'geoline', host:'sec.org', path:'/a'});
        await fail({type:'geoline', host:'sec.org', a:10});
        await fail({type:'geoline', host:'asec.org', path:'aaa'});
        await fail({type:'geoline', path:'aaa'});
        await fail({type:'geoline', aquery:1});
        await pass({type:'geoline', ids:1}, 'http://maps.nonsec.org/geoline?ids=1');
        await pass({type:'geoline', host:'maps.sec.org', ids:'a1,b4'}, 'https://maps.sec.org/geoline?ids=a1%2Cb4');

        await pass({type:'wikifile', path:'Einstein_1921.jpg'}, 'https://domain.sec.org/wiki/Special:Redirect/file/Einstein_1921.jpg');
        await pass({type:'wikifile', path:'Einstein_1921.jpg', width:10}, 'https://domain.sec.org/wiki/Special:Redirect/file/Einstein_1921.jpg?width=10');
        await pass({type:'wikifile', host:'sec.org', path:'Einstein_1921.jpg'}, 'https://sec.org/wiki/Special:Redirect/file/Einstein_1921.jpg');

        await fail({type:'mapsnapshot', host:'sec.org'});
        await fail({type:'mapsnapshot', width:100});
        await fail({type:'mapsnapshot', width:100, height:100, lat:10, lon:10, zoom:5, style:'@4'});
        await fail({type:'mapsnapshot', width:100, height:100, lat:10, lon:10, zoom:5, style:'a$b'});
        await fail({type:'mapsnapshot', width:100, height:100, lat:10, lon:10, zoom:5, lang:'a$b'});
        await pass({type:'mapsnapshot', width:100, height:100, lat:10, lon:10, zoom:5}, 'http://maps.nonsec.org/img/osm-intl,5,10,10,100x100@2x.png');
        await pass({type:'mapsnapshot', width:100, height:100, lat:10, lon:10, zoom:5, style:'osm'}, 'http://maps.nonsec.org/img/osm,5,10,10,100x100@2x.png');
        await pass({type:'mapsnapshot', width:100, height:100, lat:10, lon:10, zoom:5, style:'osm', lang:'local'}, 'http://maps.nonsec.org/img/osm,5,10,10,100x100@2x.png?lang=local');

        await fail({type:'tabular', host:'sec.org'});
        await fail({type:'tabular', host:'sec.org', path: '/'});
        await fail({type:'tabular', host:'sec.org', a:10});
        await fail({type:'tabular', host:'asec.org', path:'aaa'});
        await fail({type:'tabular', path:'abc|xyz'});
        await fail({type:'tabular', host:'sec.org', path:'abc|xyz'});
        await passWithCors({type:'tabular', path:'abc'}, 'https://domain.sec.org/w/api.php?format=json&formatversion=2&action=jsondata&title=abc&uselang=en');
        await passWithCors({type:'tabular', path:'abc/xyz'}, 'https://domain.sec.org/w/api.php?format=json&formatversion=2&action=jsondata&title=abc%2Fxyz&uselang=en');
        await passWithCors({type:'tabular', host:'sec.org', path:'aaa'}, 'https://sec.org/w/api.php?format=json&formatversion=2&action=jsondata&title=aaa&uselang=en');
        await passWithCors({type:'tabular', host:'sec.org', path:'aaa', a:10}, 'https://sec.org/w/api.php?format=json&formatversion=2&action=jsondata&title=aaa&uselang=en');
        await passWithCors({type:'tabular', host:'sec.org', path:'abc/def'}, 'https://sec.org/w/api.php?format=json&formatversion=2&action=jsondata&title=abc%2Fdef&uselang=en');
        await passWithCors({type:'tabular', host:'sec', path:'aaa'}, 'https://sec.org/w/api.php?format=json&formatversion=2&action=jsondata&title=aaa&uselang=en');
        await passWithCors({type:'tabular', host:'sec', path:'abc/def'}, 'https://sec.org/w/api.php?format=json&formatversion=2&action=jsondata&title=abc%2Fdef&uselang=en');
        await passWithCors({type:'tabular', host:'wikiraw.sec.org', path:'abc'}, 'https://wikiraw.sec.org/w/api.php?format=json&formatversion=2&action=jsondata&title=abc&uselang=en');

        await fail({type:'map', host:'sec.org'});
        await fail({type:'map', host:'sec.org', path: '/'});
        await fail({type:'map', host:'sec.org', a:10});
        await fail({type:'map', host:'asec.org', path:'aaa'});
        await fail({type:'map', path:'abc|xyz'});
        await fail({type:'map', host:'sec.org', path:'abc|xyz'});
        await passWithCors({type:'map', path:'/abc'}, 'https://domain.sec.org/w/api.php?format=json&formatversion=2&action=jsondata&title=abc&uselang=en');
        await passWithCors({type:'map', path:'/abc/xyz'}, 'https://domain.sec.org/w/api.php?format=json&formatversion=2&action=jsondata&title=abc%2Fxyz&uselang=en');
        await passWithCors({type:'map', host:'sec.org', path:'/aaa'}, 'https://sec.org/w/api.php?format=json&formatversion=2&action=jsondata&title=aaa&uselang=en');
        await passWithCors({type:'map', host:'sec.org', path:'/aaa', a:10}, 'https://sec.org/w/api.php?format=json&formatversion=2&action=jsondata&title=aaa&uselang=en');
        await passWithCors({type:'map', host:'sec.org', path:'/abc/def'}, 'https://sec.org/w/api.php?format=json&formatversion=2&action=jsondata&title=abc%2Fdef&uselang=en');
        await passWithCors({type:'map', host:'sec', path:'/aaa'}, 'https://sec.org/w/api.php?format=json&formatversion=2&action=jsondata&title=aaa&uselang=en');
        await passWithCors({type:'map', host:'sec', path:'/abc/def'}, 'https://sec.org/w/api.php?format=json&formatversion=2&action=jsondata&title=abc%2Fdef&uselang=en');
        await passWithCors({type:'map', host:'wikiraw.sec.org', path:'/abc'}, 'https://wikiraw.sec.org/w/api.php?format=json&formatversion=2&action=jsondata&title=abc&uselang=en');
    });

    it('sanitize for type=open', async function () {
        var wrapper = createWrapper(false),
            pass = async function (url, expected) {
                const result = await wrapper.sanitize(url, {type: 'open', domain: 'domain.sec.org'});
                assert.equal(result.href, expected, JSON.stringify(url));
            },
            fail = async function (url) {
                await expectError(async function () {
                    return await wrapper.sanitize(url, {type: 'open', domain: 'domain.sec.org'});
                }, url, ['Vega4Wrapper.sanitize', 'VegaWrapper._validateExternalService']);
            };

        await fail({type:'wikiapi', host:'sec.org', a:1});
        await fail('wikirest:///api/abc');
        //await fail('///My%20page?foo=1');

        await pass({type:'wikititle', path:'My page'}, 'https://domain.sec.org/wiki/My_page');
        //await pass('///My%20page', 'https://domain.sec.org/wiki/My_page');
        await pass({type:'wikititle', host:'sec.org', path:'My page'}, 'https://sec.org/wiki/My_page');
        //await pass('//my.sec.org/My%20page', 'https://my.sec.org/wiki/My_page');

        // This is not a valid title, but it will get validated on the MW side
        //await pass('////My%20page', 'https://domain.sec.org/wiki/%2FMy_page');

        await pass({type:'http', path:'/wiki/Http page'}, 'https://domain.sec.org/wiki/Http_page');
        await pass({type:'https', path:'/wiki/Http page'}, 'https://domain.sec.org/wiki/Http_page');
        await pass({type:'http', host:'my.sec.org', path:'/wiki/Http page'}, 'https://my.sec.org/wiki/Http_page');
        await pass({type:'https', host:'my.sec.org', path:'/wiki/Http page'}, 'https://my.sec.org/wiki/Http_page');

        await fail({type:'http', path:'Http page'});
        await fail({type:'https', path:'/w/Http page'});
        await fail({type:'https', path:'/wiki/Http page', a:1});
    });

});