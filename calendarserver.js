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
if(("undefined" === typeof cfgdata.CombinedCalendarFileName) ||
   ("undefined" === typeof cfgdata.calendars)) {
   console.err("Configuration data not loaded - corrupt or incomplete configdata.json file");
   process.exit(1);
}

// Post-process the variables for convenience, especially with that pesky milliseconds requirement

//Maxmimum look-back for Event Data
var maxLookBack = cfgdata.MaxEventLookBackDays * 86400 * 1000; 
//Used to define how far in the future we'll show events
var maxLookAhead = cfgdata.MaxEventLookAheadDays * 86400 * 1000;
//Used to define an "Active" Event - Time Window BEFORE event starts that event is
var preEventStartWarmupPeriod= cfgdata.PreEventHeatingTimeHrs * 3600 * 1000;
//Time before END of an event to consider it closed. 
var preEventEndCooldownPeriod= cfgdata.PreEventEndCooldownTimeHrs * 3600 * 1000;
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
var dataRequestURI = "/CalDataJSON";
// Metadata response (to check health)
var metaDataRequestURI = "/CalMetaJSON";

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
    relayUpdateLastReq: 0,
    numEvents : 0 
}

/*************************************************************************************
Master Program Logic goes:
--------------------------
 0) Read Calendar Data from local file
 1) Start a SERVER listening for HTTP on port <srvListenPort>
 2) ON REQUEST:
    a) If for anything other that /CalDataJSON:
         - Serve up a defined display webpage with embedded javascript for retrieve
    b) If for /CalDataJSON:
         - Check for valid cached internal event list. Return as JSON if available
         - Else, request a refresh and return *that*
**************************************************************************************/
//Force caldata re-read on start:
//(KEEP - otherwise 1st call will come back blank due to async refresh)
refreshCalData();

//MAIN LOOP:
var calServ = http.createServer(function(req,res){
    //Get the request URL and act accordingly:
    var locReq = url.parse(req.url).pathname;
    var timeSpec = url.parse(req.url).search;
    calData.lastReq = new Date(Date.now());
    console.log(calData.lastReq + " Received request for URL: " + req.url); 
    if(locReq == dataRequestURI) {
        //This is a request for the parsed calendar data stream
        res.setHeader('Content-Type', 'application/json');
        //Check for valid current data; queue a refresh request if not
        //reset age counter since it might be a while since our last request.
        //fileAgeThreshold = new Date(Date.now()- fileCheckAge);
        calData.checkAgeThreshold = new Date(Date.now()-fileCheckAge);
        //reset event search window markers for same reason
        oldestEventAge = new Date(Date.now() - maxLookBack);
        newestEventAge = new Date(Date.now() + maxLookAhead);
        //Check: If data age older than 10 mins we might need to refresh
        if(calData.checkTime < calData.checkAgeThreshold || calData.numEvents < 1 ) {
            calData.checkTime = new Date(Date.now());
            refreshCalData();
        }
        //Sub-categorise the output date range, if supplied
        if(timeSpec == "?today") {
            console.log("Asked for TODAYS (remaining) events");
            var earliest = new Date(Date.now());
            var latest = new Date(earliest.getFullYear(),earliest.getMonth(),earliest.getDate(),23,59,59,999);
            res.end(JSON.stringify(eventsWithinDateRange(calevents,earliest,latest),null,3));
        } else if(timeSpec == "?activeEvents") {
            console.log("Asked for ACTIVE events");
            res.end(JSON.stringify(eventsActiveNow(calevents),null,3));
        } else if(timeSpec == "?nextEventByLocation") {
            console.log("Asked for NEXT EVENT BY LOCATION");
            res.end(JSON.stringify(nextEventByLocation(calevents),null,3));
        } else {
            console.log("Returning ALL events...");
            res.end(JSON.stringify(calevents,null,3));
        }
        //Book-keeping time: For Metadata / Healthcheck reasons we want to record
        //the request time IF the requestor is our relay update script
        var reqHost = req.headers['host'];
        var reqUA = req.headers['user-agent'];
        if(reqHost.startsWith('localhost') && reqUA.startsWith('caltriggerrelays')) {
            console.log(' -> Request was from Relay Update Script');
            calData.relayUpdateLastReq = calData.lastReq;
        }
    } else if(locReq == metaDataRequestURI) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(calData,null,3));
    } else {
        //This is some other request we'll serve as a static file from the $localHTMLroot dir
        //Default to the index page:
        var filename = path.join(cfgdata.HTMLDirectory, "/index.html");
        if(locReq.length > 1) {
            filename = path.join(cfgdata.HTMLDirectory, locReq);
        }

        var fStats;
        try {
            fStats = fs.lstatSync(filename); //throws if file does not exist:
        } catch (e) {
            console.log("Request for missing file: " + filename);
            res.writeHead(404, {'Content-Type': 'text/plain'});
            res.end("404 File Not Found\n");
            return;
        }
        if (fStats.isFile()) {
            var mimeType = mimeTypes[path.extname(filename).split(".")[1]];
            res.writeHead(200,{'Content-Type':mimeType});
            var fileStream = fs.createReadStream(filename);
            fileStream.pipe(res);
        } else {
            res.writeHead(403, {'Content-Type': 'text/plain'});
            res.end("403 Forbidden\n");
        }

    }
});
calServ.listen(cfgdata.ServerListenPort);
console.log('Server listening:' + calServ.listening);
console.log('Listener URL: http://localhost:' + cfgdata.ServerListenPort + '/');


//Called to check whether data is required to be re-read, does so if
//necessary
// (NOTE: Now relies on external file / url retrieval)
function refreshCalData() {
    console.log('Checking state of cached data...');
    fs.stat(cfgdata.CombinedCalendarJSONFile, function(err, stats) {
        if(err) {
            console.log('unable to stat calendar data file ', cfgdata.CombinedCalendarJSONFile)
            return;
        }  
        calData.fileLastModified = new Date(util.inspect(stats.mtime));
        if(calData.fileLastModified > calData.fileLastLoaded) {
            //File has been modified since we last read it, so re-read it
            console.log('Calendar Data File modified since we last read it, re-reading');
            try  {
                //NOTE: Default require() behaviour is to cache objects on first load. 
                //We need to circumvent this behaviour by forcing a cache expire. Hence the chicanery:
                delete require.cache[require.resolve(cfgdata.CombinedCalendarJSONFile)];
                calevents = []; //reset the object
                calevents = turnStringTimesIntoDateObjects(require(cfgdata.CombinedCalendarJSONFile));
            } catch (e) {
                console.log('Error in JSON file ' + cfgdata.CombinedCalendarJSONFile + ' - ' + e);
            }
            //Update metadata to allow display:
            calData.numEvents = calevents.length;
            //Update reloaded time counter
            calData.fileLastLoaded = new Date(Date.now());
            console.log('Calendar data re-loaded. ' + calData.numEvents + ' total events');
        } else {
            console.log("Calendar Data file hasn't changed; Returning existing data")
        }
    });
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
//or an endtime BEFORE the latest time
function eventsWithinDateRange(listOfEvents,earliest,latest) {
    var matchingEvents = [];
    console.log("\tSearching for events in range...");
    console.log("\t\tSTARTS AFTER:   " + earliest);
    console.log("\t\tFINISHES BEFORE:" + latest);
    for (var i in listOfEvents) {
        var ev = listOfEvents[i];
        if( (ev.start.getTime() >= earliest ) &&
            (ev.end.getTime() <= latest ) ) {
            matchingEvents.push(ev);
        }
    }
    console.log("\tReturning " + matchingEvents.length + " matching events from " + listOfEvents.length + " available")
    return matchingEvents;
}

//Inevitably there's a special case. In this case we need to work out "Active Events" for heating control purposes.
//Definition of Active:  (START TIME - warmupTime) is before now
//                       (END TIME - cooldownTime) is after now 
// Noting that the desired return set is therefore made up of "current" events with an adjusted start/finish window
//
function eventsActiveNow(listOfEvents) {
    var activeEvents = [];
    var now = new Date(Date.now());
    console.log("\tSearching for ACTIVE events:");
    for (var i in listOfEvents) {
        var ev = listOfEvents[i];
        if( ((ev.start.getTime() - preEventStartWarmupPeriod) < now) &&
            ((ev.end.getTime() - preEventEndCooldownPeriod) > now) ) {
            activeEvents.push(ev);
        }
    }
    console.log("\tReturning " + activeEvents.length + " matching events");
    return activeEvents;
}

function nextEventByLocation(listOfEvents) {
    var nextEventByLocation = new Object();
    var now = new Date(Date.now());
    for (var i in listOfEvents) {
        var ev = listOfEvents[i];
        //skip ALL events in past
        if(ev['start'] < now) {
            continue;
        }
        
        //Initialise location if required
        if(!(ev['location'] in nextEventByLocation)) {
            nextEventByLocation[ev['location']] = ev;
        }
        //Otherwise, check whether it's earlier than stored or not
        if(ev['start'] < nextEventByLocation[ev['location']]['start']) {
            nextEventByLocation[ev['location']] = ev;
        }
    }
    //Now, because we've made a rod for our own backs, turn this back into an array
    var matchingEvents = [];
    for(loc in nextEventByLocation) {
        matchingEvents.push(nextEventByLocation[loc]);
    }
    console.log("\t\Returning " + matchingEvents.length + " events by location");
    return matchingEvents;
}

