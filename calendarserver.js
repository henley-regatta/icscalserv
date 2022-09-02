// calendarserver.js
// -----------------
// (Converted from the Pi Heating Suite's servecal.js)
//
// Serves a locally-hosted (set of) calendars providing JSON 
// output for restricted events clustered around "now".  Will periodically
// look for updates to the JSON file allowing for reloading of 
// data from an ICS retrieve to occur asynchronously.
// 
// The primary reason being to provide "low memory" hosting of 
// events in the near future which might suit a display program 
// looking for lightweight near-term calendar data.
//
// Can run on any recent Node system but you'll want some additional
// modules installed to allow for parsing and hosting, see package.json 
// for details
//
// After this, run the server using "node calendarserver.js"
/*************************************************************************************/
//
// BUGLIST
// -------
// 2022-08-30 - Incomplete conversion from servecal.js.
/*************************************************************************************/

// Import the environment definition file (JSON)
// Interesting note: Omit the file extension (.json) and Node will first try a .JS allowing for
// future options. But it'll still read the .json if it doesn't find it....
var cfgdata = require('./configdata');

//Quick check and bang-out if we don't have the data we need
if(("undefined" === typeof cfgdata.calendarJSONFile) ||
   ("undefined" === typeof cfgdata.calendars) ||
   ("undefined" === typeof cfgdata.ServerListenPort)) {
   console.err("Configuration data not loaded - corrupt or incomplete configdata.json file");
   process.exit(1);
}

// Post-process the variables for convenience, especially with that pesky milliseconds requirement

//Maximum look-back for Event Data
//(convert to JS Millis)
var maxLookBack = cfgdata.MaxEventLookBackDays * 86400 * 1000; 
//Used to define how far in the future we'll show events
var maxLookAhead = cfgdata.MaxEventLookAheadDays * 86400 * 1000;

//DEFAULT time-window to serve events if no parameters supplied
var defaultServeLookBack = 0 //"Now"
var defaultServeLookAhead = 2 * 86400 * 1000 // 2 days
/*
END OF GLOBAL VARIABLES
-----------------------
(No User Modifiable Parts Below This Line)
**************************************************************************************/


//comprehender for calendar files:
//(use the broader node version)
var ical = require('node-ical');
//Library to work with recurring events (aka "godsend");
var RRule = require('rrule').RRule;
//filesystem functions:
var fs = require('fs');
//Http support - we don't need our output encrypted 
var http = require('http');
//to understand passed urls:
var url = require('url');
//to understand filesystem paths:
var path = require('path');
//utility functions:
var util = require('util');
//Date formatting support
var dayjs = require('dayjs')
//Process support.
const { emitWarning } = require('process');

//Master Operation Control Var:
//(Should not be user-modified)
var haveCurrentCalFile = false;
//Used to define how often this script should check for a new data file
//(to limit re-reads). Default = 10 minutes
var fileCheckAge = 10*60*1000;
var fileAgeThreshold = new Date(Date.now() - fileCheckAge);
//These variables get updated on each request but need an initial value:
var oldestEventAge = new Date(Date.now() - maxLookBack);
var newestEventAge = new Date(Date.now() + maxLookAhead);

// URI for Dataretrieve:
var dataRequestURI = "/JSON";
// Metadata response (to check health)
var metaDataRequestURI = "/Health";

//Used to determine the filetype sent back:
var mimeTypes = {
    "html": "text/html",
    "jpeg": "image/jpeg",
    "jpg": "image/jpeg",
    "png": "image/png",
    "js": "text/javascript",
    "css": "text/css"};

//
//Master data structure to hold CURRENT events:
//(populated by the parseCal() function)
//
var calevents = [];
// CalEvents metadata for tracking and serving:
var calData = {
    checkTime: 0,
    checkAgeThreshold: 0,
    lastReq: 0,
    fileLastModified: 0,
    fileLastLoaded: 0,
    numEvents : 0,
    numCals : 0,
    calNames : []      //needed for parsing output into blocks
}

/*************************************************************************************
Master Program Logic goes:
--------------------------
 0) Read Calendar Data from JSON Store
 1) Start a SERVER listening for HTTP on port <srvListenPort>
 2) ON REQUEST:
    a) If for $dataRequestURI:
        - Parse parameters for timewindow (if supplied), otherwise use defaults
        - Supply JSON response based on timewindow of data loaded from file
    b) If for $metaDataRequestURI:
        - Serve JSON response of internal values in $calData
    c) If for anything else 
        - 404 not found
**************************************************************************************/

//Force caldata re-read on start:
//(KEEP - otherwise 1st call will come back blank due to async refresh)
refreshCalData();
//Setup async refresh every fileCheckAge millis:
setInterval(refreshCalData,fileCheckAge);

//MAIN LOOP:
var calServ = http.createServer(function(req,res){
    //Get the request URL and act accordingly:
    var locReq = url.parse(req.url).pathname;
    var timeSpec = url.parse(req.url).search;
    calData.lastReq = dayjs().format();
    console.log(`${calData.lastReq} - INFO - request for ${req.url}`); 
    if(locReq == dataRequestURI) {
        //res.setHeader('Content-Type', 'application/json');
        //res.end(JSON.stringify(calevents));
        serveCalData(req,res,timeSpec)
    } else if(locReq == metaDataRequestURI) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(calData,null,3));
    } else {
        // Didn't recognise the request, 404 it.
        console.log(`${calData.lastreq} - WARN - Request for unknown path ${locReq}`)
        res.writeHead(404, {'Content-Type': 'text/plain'});
        res.end(`404 File Not Found (${locReq}). Supported endpoints:\n\t${dataRequestURI}\n\t${metaDataRequestURI}\n`);
        return;
    }
});
calServ.listen(cfgdata.ServerListenPort);
ts = dayjs().format();
console.log(`${ts} - INFO - Server listening: ${calServ.listening}`);
console.log(`${ts} - INFO - Listener URL:     http://localhost:${cfgdata.ServerListenPort}/`);

//
// ------------------------------------------------------------------------------
//
function serveCalData(req,res,timeSpec) {
    //This is a request for the parsed calendar data stream
    res.setHeader('Content-Type', 'application/json');
    //reset event search window markers since it might have been a while since last request
    oldestEventAge = new Date(Date.now() - maxLookBack);
    newestEventAge = new Date(Date.now() + maxLookAhead);

    dLB = new Date(Date.now() - defaultServeLookBack);
    dLF = new Date(Date.now() + defaultServeLookAhead);

    //reset to day boundaries (used as default):
    var timeCriteria = "DEFAULT";
    var earliest = new Date(dLB.getFullYear(),dLB.getMonth(),dLB.getDate(),00,00,00,00);
    var latest   = new Date(dLF.getFullYear(),dLF.getMonth(),dLF.getDate(),23,59,59,59);
    n = new Date(Date.now());
    
    //Sub-categorise the output date range, if supplied. If not supplied, use default range
    if(timeSpec == "?today") {
        timeCriteria = "TODAY";
        earliest     = new Date(n.getFullYear(),n.getMonth(),n.getDate(),00,00,00,00); 
        latest       = new Date(n.getFullYear(),n.getMonth(),n.getDate(),23,59,59,999);
    } else if(timeSpec == "?tomorrow") {
        timeCriteria = "TOMORROW";
        earliest     = new Date(n.getFullYear(),n.getMonth(),n.getDate(),23,59,59,999);
        latest       = new Date(n.getFullYear(),n.getMonth(),n.getDate()+1,23,59,59,999);
    } else if(timeSpec == "?week") {
        timeCriteria = "WEEK";
        earliest     = new Date(n.getFullYear(),n.getMonth(),n.getDate(),23,59,59,999);
        latest       = new Date(n.getFullYear(),n.getMonth(),n.getDate()+7,23,59,59,999);
    } else if(timeSpec == "?fullrange") {
        timeCriteria = "ALLEVENTS";
        earliest     = oldestEventAge;
        latest       = newestEventAge;
    }
    matchingEvents = eventsWithinDateRange(calevents,earliest,latest)
    ts = dayjs().format();
    console.log(`${ts} - INFO - returning ${matchingEvents.length} events matching ${timeCriteria}, between ${earliest} and ${latest}`);
    res.end(JSON.stringify(reformatEventsForSerialisation(matchingEvents),null,1));
}

//
// ------------------------------------------------------------------------------
// It's easier for an endpoint to consume if we split the events by calendar
// (and we'd like a header section, and we can reduce the size of the output with trimming)
function reformatEventsForSerialisation(ev) {
    var outStruct = {
        "time" : new Date(Date.now()),
        //TODO - would be nice to get weather and put it in here, wouldn't it?
        "tempDegrees" : 22,
        "weatherForecast" : "showers",
        "cals" : new Object()
    }
    for(n in calData.calNames) [
        outStruct.cals[calData.calNames[n]] = []
    ]
    for(i in ev) {
        let e = ev[i];
        //Shorten the data, push to cals struct
        outStruct.cals[e.cal].push({
            "title" : e.title, 
            "start" : e.start, 
            "end"   : e.end,
            "location" : e.location
         });
    }
    
    return outStruct;
}


//Called to check whether data is required to be re-read, does so if
//necessary
// (NOTE: Now relies on external file / url retrieval)
function refreshCalData() {
    calData.checkTime = new Date(Date.now())
    ts = dayjs().format()
    console.log(`${ts} - INFO - Checking state of cached data...`);
    calData.checkAgeThreshold = new Date(Date.now()-fileCheckAge);
    fs.stat(cfgdata.calendarJSONFile, function(err, stats) {
        if(err) {
            console.log(`${ts} - FATAL - unable to stat calendar data file: ${cfgdata.calendarJSONFile}`);
            //This, is a problem. We need that data available.
            process.exit(1);
        }  
        calData.fileLastModified = new Date(util.inspect(stats.mtime));
        if(calData.fileLastModified > calData.fileLastLoaded) {
            //File has been modified since we last read it, so re-read it
            console.log(`${ts} - INFO  - Calendar Data File modified since we last read it, re-reading`);
            //NB - Require() Considered Harmful for non-static data...
            fs.readFile(cfgdata.calendarJSONFile,(error,data) => {
                if(error) {
                    console.log(`${ts} - FATAL - Error reading file ${cfgdata.calendarJSONFile} : ${error}`);
                    //This shouldn't happen and we can't continue so
                    process.exit(1)
                }
                //We could read it, but can we parse it?
                try {
                    calevents = turnStringTimesIntoDateObjects(JSON.parse(data))
                } catch (e) {
                    console.log(`${ts} - FATAL - Error parsing ${cfgdata.calendarJSONFile} : ${e}`);
                    //Again, this is non-recoverable so:
                    process.exit(1)
                }
                //Update our metadata
                calData.calNames = getCalNames(calevents)
                calData.numCals = calData.calNames.length;
                calData.numEvents = calevents.length;
                calData.fileLastLoaded = new Date(Date.now());
                console.log(`${ts} - INFO - Calendar re-loaded. ${calData.numEvents} events available`);
            });
        } else {
            console.log(`${ts} - INFO - Calendar Data file hasn't changed; Events not refreshed`);
        }
    });
}

// helper function during refresh.
function getCalNames(caldata) {
    var cNames = []
    for(var e in caldata) {
        if(!cNames.includes(caldata[e].cal)) {
            cNames.push(caldata[e].cal);
        }
    }
    return cNames;
}

//We're mostly OK with the to-JSON / from-JSON conversions but we *do* need to turn
//the timestamps back into date objects, so....
function turnStringTimesIntoDateObjects(listOfEvents) {
    outEvents = [];
    for(var i in listOfEvents) {
        var ev = listOfEvents[i];
        ev.start = new Date(ev.start);
        ev.end = new Date(ev.end);
        outEvents.push(ev);
    }
    return outEvents;
}

//Extract from the total list of events those with a starttime AFTER the earliest time
//AND a starttime EARLIER than the latest time
//(because End time might be zero / start-of-epoch for events without duration)
function eventsWithinDateRange(listOfEvents,earliest,latest) {
    var matchingEvents = [];
    for (var i in listOfEvents) {
        var evstart = listOfEvents[i].start 
        if (evstart>=earliest && evstart<=latest) {
           //console.log(`${evstart} is between ${earliest} and ${latest}`)
            matchingEvents.push(listOfEvents[i]);
        }
    }
    //TODO: Sort by "start"
    return matchingEvents.sort(function(a,b){return a.start - b.start});
}


