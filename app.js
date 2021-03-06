/*eslint-env node */

var bodyParser = require('body-parser');
var Cloudant = require('cloudant');
var cfenv = require('cfenv');
var express = require('express');
var swig = require('swig');
var watson = require('watson-developer-cloud');

// ------------------
// App configuration
// ------------------
var app = express();
app.use(bodyParser.json());
app.use(express.static(__dirname + '/public'));

// ------
// Watson
// ------
var insights = watson.personality_insights({
    version: 'v2'
});

// -----------
// Environment
// -----------
var appEnv = cfenv.getAppEnv();

// ------------------------
// Database initialization
// ------------------------
var dbCredentials;
var db;

function initializeDatabase() {
    if (process.env.VCAP_SERVICES) {
        var vcapServices = JSON.parse(process.env.VCAP_SERVICES);

        if (vcapServices.cloudantNoSQLDB) {
            var cloudantServices = vcapServices.cloudantNoSQLDB[0].credentials;

            dbCredentials = {
                dbName: 'sessions',
                host: cloudantServices.host,
                port: cloudantServices.port,
                user: cloudantServices.username,
                password: cloudantServices.password,
                url: cloudantServices.url
            };

            var cloudant = Cloudant(dbCredentials.url);
            cloudant.db.create(dbCredentials.dbName, /* @callback */ function(err, res) {
                if (err) { console.log('Have not created database, it already exists'); }
            });

            db = cloudant.db.use(dbCredentials.dbName);
            return;
        }
    }

    console.error('Could not establish connection to Cloudant database');
}

initializeDatabase();

// -----------------------------------------
// setContent: receive text from mobile app
// -----------------------------------------
app.post('/setContent', function (req, res) {
    checkSetContentRequestValidity(req, function (isValid, errorMessage) {
        if (!isValid) {
            sendPostError(res, errorMessage);
        }
        else {
            processContentUnchecked(req, function (err) {
                if (err) {
                    sendPostError(res, 'Could not fetch Personality Insights');
                }
                else {
                    sendPostSuccess(res);
                }
            });
        }
    });
});

function sendPostError(res, message) {
    var responseJSON = {
        message: {
            title: 'Error',
            description: message
        }
    };

    res.status(400).json(responseJSON);
}

function sendPostSuccess(res) {
    res.status(200).json({});
}

function checkSetContentRequestValidity(req, handler) {
    if (isSessionIDGiven(req)) {
        if (isContentGiven(req)) {
            handler(true, undefined);
        }
        else {
            handler(false, 'Invalid content!');
        }
    }
    else {
        handler(false, 'Invalid session ID!');
    }
}

function isSessionIDGiven(req) {
    return getSessionIDUnchecked(req) !== undefined;
}

function getSessionIDUnchecked(req) {
    return req.query.sessionId;
}

function isContentGiven(req) {
    var body = req.body;
    return body['form'] && body['form']['content'];
}

function getContentUnchecked(req) {
    return req.body['form']['content'];
}

function processContentUnchecked(req, handler) {
    var content = getContentUnchecked(req);
    var sessionID = getSessionIDUnchecked(req);
    var insightsConfig = {
            text: content,
            language: 'en'
        };

    insights.profile(insightsConfig, function (err, response) {
        if (err) {
            console.error('Personality insights fetch failed: ', err);
            handler(err);
        }
        else {
            var responseString = JSON.stringify(response);
            updateDatabaseContent(content, sessionID, responseString, function (err) {
                handler(err);
            });
        }
    });
}

function updateDatabaseContent(content, sessionID, response, handler) {
    var doc;

    db.get(sessionID, function(err, data) {
        if (!err && data) {
            doc = data;
        }
        else {
            doc = {
                sessionID: sessionID
            };
        }

        doc.content = content;
        doc.response = response;
        doc.created = new Date().toLocaleString();

        db.insert(doc, sessionID, /* @callback */ function(err, body, header) {
            if (err) {
                console.error('Failed to insert content: ' + err);
            }

            handler(err);
        });
    });
}

// ------------------------------------------------
// getDescription: returns personality description
// ------------------------------------------------
app.get('/getDescription', function (req, res) {
    getLatestInsightsJSON(req, function(insights) {
        if (insights) {
            var items = parseDescriptionFromWatsonResponse(req, insights);
            sendDescriptionSuccess(res, items);
        }
        else {
            sendPostError(res, 'No content defined for this session');
        }
    });
});

function sendDescriptionSuccess(res, items) {
    res.status(200).json(items);
}

function parseDescriptionFromWatsonResponse(req, response) {
    var sessionID = getSessionIDUnchecked(req);
    var tree = response['tree']['children'];
    var items = parseChildren(tree, 0);
    items = items.filter(function (item) {
        return item.type !== '2';
    });

    items.forEach(function (item) {
        if (item.graphURL) {
            item.graphURL += '/?sessionId=' + sessionID;
            item.showGraph = 'true';
        }
        else {
            item.showGraph = 'false';
        }

        item.isHeader = isHeader(item);
        item.isSubheader = isSubheader(item);
        item.isLeaf = isLeaf(item);
    });

    return items;
}

function isHeader(item) {
    return item.type === '1';
}

function isSubheader(item) {
    return item.type === '3' && item.hasChildren === 'true';
}

function isLeaf(item) {
    return item.hasChildren === 'false' && (item.type === '3' || item.type === '4');
}

function parseChildren(itemRoot, nestLevel) {
    var allChildren = [];

    if (itemRoot && Array.isArray(itemRoot)) {
        for (var i = 0; i < itemRoot.length; ++i) {
            var childJSON = itemRoot[i];
            var child = createChildFromJSON(childJSON, nestLevel);
            allChildren.push(child);

            var childRoot = childJSON['children'];
            var children = parseChildren(childRoot, nestLevel + 1);
            allChildren = allChildren.concat(children);
        }
    }

    return allChildren;
}

var idsWithGraphs = ['personality', 'Openness', 'Conscientiousness', 'Extraversion',
    'Agreeableness', 'Neuroticism', 'needs', 'values'];

function createChildFromJSON(json, nestLevel) {
    var child = {
        id: json['id'],
        name: json['name'],
        value: formatPercentage(json['percentage']),
        type: (nestLevel + 1).toString(),
        hasChildren: (json['children'] !== undefined) + ''
    };

    if (idsWithGraphs.indexOf(child.id) > -1) {
        child.graphURL = appEnv.url + '/getGraph/' + child.id;
    }

    return child;
}

function formatPercentage(percentage) {
    if (percentage) {
        return (percentage * 100).toFixed(2) + '%';
    }
}

function getLatestInsightsJSON(req, handler) {
    getLatestResponse(req, function(response) {
        if (response) {
            handler(JSON.parse(response));
        }
        else {
            handler(response);
        }
    });
}

function getLatestResponse(req, handler) {
    var sessionID = getSessionIDUnchecked(req);
    var response;

    db.get(sessionID, function(err, data) {
        if (err) {
            console.error('Content fetching error: ', err);
        }
        else if (data) {
            response = data.response;
        }
        else {
            console.error('No entry for sessionID: ' + sessionID);
        }

        handler(response);
    });
}

// -------------------------------------------
// getGraph: returns URL to personality chart
// -------------------------------------------
app.get('/getGraph/:watsonId', function(req, res) {
    var template = swig.compileFile('templates/chart.html');

    getLatestInsightsJSON(req, function(insights) {
        if (insights) {
            var itemRoot = insights['tree']['children'];
            var child = getChildWithId(req.params.watsonId, itemRoot);

            if (child) {
                var rendered = template({
                    data: JSON.stringify(createChartData(child)),
                    options: JSON.stringify(createChartOptions())
                });

                res.send(rendered);
                return;
            }
        }

        var errorTemplate = swig.compileFile('templates/404.html');
        res.status(404).send(errorTemplate({}));
    });
});

function getChildWithId(id, itemRoot) {
    if (itemRoot && Array.isArray(itemRoot)) {
        for (var i = 0; i < itemRoot.length; ++i) {
            var child = itemRoot[i];

            if (child['id'] === id) {
                if (child['children'] && child['children'].length === 1) {
                    return child['children'][0];
                }

                return child;
            }

            child = getChildWithId(id, child['children']);

            if (child) {
                return child;
            }
        }
    }
}

var colors = ['#4178BD', '#9854D4', '#01B4A0', '#D74009', '#323232', '#EDC01C'];
var highlights = ['#5596E6', '#AF6EE8', '#41D6C3', '#FF5006', '#555555', '#FAE249'];

function createChartData(rootJSON) {
    var children = rootJSON['children'];
    var data = [];

    for (var i = 0; i < children.length; ++i) {
        var child = children[i];
        var value = (child['percentage'] * 100).toFixed(2);

        data.push({
            value: value,
            color: colors[i % colors.length],
            highlight: highlights[i % highlights.length],
            label: child['name']
        });
    }

    return data;
}

function createChartOptions() {
    return {
        scaleShowLabelBackdrop : true,
        scaleBackdropColor : "rgba(255,255,255,0.75)",
        scaleBeginAtZero : true,
        scaleBackdropPaddingY : 2,
        scaleBackdropPaddingX : 2,
        scaleShowLine : true,
        segmentShowStroke : true,
        segmentStrokeColor : "#fff",
        segmentStrokeWidth : 2,
        animationSteps : 100,
        animationEasing : "easeOutBounce",
        animateRotate : true,
        animateScale : false,
        legendTemplate : "<ul class=\"<%=name.toLowerCase()%>-legend\"><% for (var i=0; i<segments.length; i++){%><li><span style=\"background-color:<%=segments[i].fillColor%>\"></span><%if(segments[i].label){%><%=segments[i].label%><%}%></li><%}%></ul>"
    };
}

// -------------------------------------------
// Welcome screen
// -------------------------------------------
app.get('/', function (req, res) {
    var template = swig.compileFile('templates/index/index.html');
    var urls = {
        formUrl: req.protocol + '://' + req.get('host') + '/setContent',
        feedUrl: req.protocol + '://' + req.get('host') + '/getDescription',
        appTemplateUrl: 'https://bluemix.kinetise.com/developer/generator/index/template/watson?backendUrl=' + escape(req.protocol + '://' + req.get('host'))
    };

    res.status(200).send(template(urls));
});

// -------------------------------------------
// App initialization
// -------------------------------------------
app.listen(appEnv.port, function() {
    console.log("server starting on " + appEnv.url);
});
