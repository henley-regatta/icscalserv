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
// for details and use "npm install" to get them.
//
// After this, run the server using "node calendarserver.js"
/*************************************************************************************/
//
// BUGLIST
// -------
// 2022-09-09 - None known. Yes I know that's asking for trouble.
/*************************************************************************************/

// Import the environment definition file (JSON)
// Interesting note: Omit the file extension (.json) and Node will first try a .JS allowing for
// future options. But it'll still read the .json if it doesn't find it....
var cfgdata = require('./configdata');

//Quick check and bang-out if we don't have the data we need
if(("undefined" === typeof cfgdata.calendars) ||
   ("undefined" === typeof cfgdata.ServerListenPort)) {
   console.err("Configuration data not loaded - corrupt or incomplete configdata.json file");
   process.exit(1);
}

/*
END OF GLOBAL VARIABLES
-----------------------
(No User Modifiable Parts Below This Line)
**************************************************************************************/


//comprehender for calendar files:
//(use the broader node version)
// https://github.com/jens-maus/node-ical/
var ical = require('node-ical');
//Library to work with recurring events (aka "godsend");
var RRule = require('rrule').RRule;
//filesystem functions:
var fs = require('fs');
//Http support - we don't need our output encrypted 
var http = require('http');
//  HTTPS support (Google Calendar reading requires this)
var https = require('https');
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




// URI for Dataretrieve:
var dataRequestURI = "/json";
// Metadata response (to check health)
var metaDataRequestURI = "/health";

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
    lastCalRefreshCheckTime: 0,
    lastSuccessfulRetrieveTime: 0,
    minDataAgeBeforeRefresh: cfgdata.MinDataAgeBeforeRefreshHrs * 3600 * 1000,
    maxLookBack: cfgdata.MaxEventLookBackDays * 86400 * 1000,
    maxLookAhead: cfgdata.MaxEventLookAheadDays * 86400 * 1000,
    defaultServeLookBack: 0, // now
    defaultServeLookAhead: 2 * 86400 * 1000, // 2 days
    lastReq: 0,
    numReqs: 0,
    numEvents : 0,
    numCals : 0,
    calNames : []      //needed for parsing output into blocks
}

//These need initial values
calData.oldestEventAge = new Date(Date.now() - calData.maxLookBack);
calData.newestEventAge = new Date(Date.now() + calData.maxLookAhead);
calData.dLB = new Date(Date.now() - calData.defaultServeLookBack);
calData.dLF = new Date(Date.now() + calData.defaultServeLookAhead);

//Set a default if not found in the config file for whether the output should be compressed 
//or not
if(cfgdata.compactOutput === "undefined") {
    cfgdata.compactOutput = true;
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
//Setup async refresh every MinDataAgeBeforeRefresh millis:
//nb: however, add an offset of 60 seconds to this because there
//    will be a delay between ASKING to refresh and RETRIEVING new data
calData.refreshCalDataInterval = calData.minDataAgeBeforeRefresh + 60 * 1000;
setInterval(refreshCalData,calData.refreshCalDataInterval);

//MAIN LOOP:
var calServ = http.createServer(function(req,res){
    //Get the request URL and act accordingly:
    var locReq = url.parse(req.url).pathname.toLowerCase();
    
    //timeSpec may not be set. But if it is, convert to lowercase      
    var timeSpec = url.parse(req.url).search ? url.parse(req.url).search.toLowerCase() : 'default';
    //Bookkeeping
    calData.lastReqHost = req.headers.host ? req.headers.host : 'UNKNOWN'
    calData.lastReq = dayjs().format();
    calData.numReqs += 1;
    console.log(`${calData.lastReq} - INFO - request ${calData.numReqs} for ${req.url} from ${calData.lastReqHost}`); 
    if(locReq == dataRequestURI) {
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
    calData.oldestEventAge = new Date(Date.now() - calData.maxLookBack);
    calData.newestEventAge = new Date(Date.now() + calData.maxLookAhead);
    calData.dLB = new Date(Date.now() - calData.defaultServeLookBack);
    calData.dLF = new Date(Date.now() + calData.defaultServeLookAhead);
    
    //reset to day boundaries (used as default):
    var timeCriteria = "DEFAULT";
    var earliest = new Date(calData.dLB.getFullYear(),calData.dLB.getMonth(),calData.dLB.getDate(),00,00,00,00);
    var latest   = new Date(calData.dLF.getFullYear(),calData.dLF.getMonth(),calData.dLF.getDate(),23,59,59,59);
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
    } else if(timeSpec == "?week" || timeSpec == "?7days") {
        timeCriteria = "WEEK";
        earliest     = new Date(n.getFullYear(),n.getMonth(),n.getDate(),23,59,59,999);
        latest       = new Date(n.getFullYear(),n.getMonth(),n.getDate()+7,23,59,59,999);
    } else if(timeSpec == "?fullrange" || timeSpec == "?allevents") {
        timeCriteria = "ALLEVENTS";
        earliest     = calData.oldestEventAge;
        latest       = calData.newestEventAge;
    }
    let matchingEvents = eventsWithinDateRange(calevents,earliest,latest)
    let ts = dayjs().format();
    console.log(`${ts} - INFO - returning ${matchingEvents.length} events matching ${timeCriteria}, between ${earliest} and ${latest}`);
    //make the output human or machine readable?
    let squeeze = cfgdata.compactOutput ? 0 : 2
    res.end(JSON.stringify(reformatEventsForSerialisation(matchingEvents),null,squeeze));
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
    calData.lastCalRefreshCheckTime = new Date(Date.now())
    calData.newCalDataCheckAgeThreshold = new Date(calData.lastCalRefreshCheckTime - calData.minDataAgeBeforeRefresh);
    ts = dayjs().format()
    if(calData.lastSuccessfulRetrieveTime > calData.newCalDataCheckAgeThreshold) {
        console.log(`${ts} - INFO - No Event Refresh; retrieved at ${calData.lastSuccessfulRetrieveTime}, refresh threshold: ${calData.newCalDataCheckAgeThreshold}`);
    } else {
        console.log(`${ts} - INFO - Refreshing events. Last retrieve at ${calData.lastSuccessfulRetrieveTime}, refresh threshold: ${calData.newCalDataCheckAgeThreshold}`);
        refreshCalendarDataFromServers().catch(console.log);
    }
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

//
// ------------------------------------------------------------------------------
// ------------------------------------------------------------------------------
// ------------------------------------------------------------------------------
// This is the code used to retrieve and parse calendars; it's available as a 
// separate executable "getandparseice.js" but more useful for embedded servers
// as a suite of functions here.
//



//This is the master function, which has to be Async because everything else under it is async.
async function refreshCalendarDataFromServers() {
    //don't zap this data until we KNOW we've got incoming events
    //calData.numCals = 0;
    //calevents = []; 
    await processCalendars(cfgdata.calendars)
}
/* --  NORMAL SCRIPT EXIT POINT -- */

//-
// ---------------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------------
//
async function processCalendars(cals) {
    //internal trackers - only update the globs on success 
    var calsRetrieved = 0
    var eventsRetrieved = []
    calProcessing = cals.map(function(cal){
        return ical.async.fromURL(cal.URL).catch(err => {console.log(`RETRIEVE ERROR FOR ${cal.Name} : ${err.message}`)})
    })
    
    calNames = cals.map(cal => cal.Name)
    Promise.all(calProcessing).then((calEvents) => {
        for(let i = 0; i < calEvents.length; i++) {
            if(calEvents[i] === undefined || calEvents[i]  == null) {
                console.log(`WARNING - No calendar data returned for ${calNames[i]}`)
            } else {
                var k = Object.keys(calEvents[i])
                if(k.length >= 0 && k[0].toLowerCase().includes("html")) {
                    console.log(`WARNING - Response contained no calendar data for ${calNames[i]}`)
                } else {
                    //HAPPY PATH
                    calsRetrieved += 1;
                    console.log(`${calNames[i]} returned ${k.length} elements`)
                    const mEvents = extractEventsFromCal(calEvents[i],calNames[i])
                    for(var ev in mEvents) {
                        if(mEvents.hasOwnProperty(ev)) {
                            eventsRetrieved.push(mEvents[ev])
                        }
                    }
                }
            }
        }
    }).finally(() => {
        processCompletedEventData(calsRetrieved,eventsRetrieved);
    });
}

//
// ------------------------------------------------------------------------------------------
// I'm beginning to hate having to work-around Node's asynchronicity
function processCompletedEventData(numProcCals,procCalEvents) {
    var ts = dayjs().format()
    //SANITY CHECK - do NOT do file IO if we've got no new event data to process...
    if(procCalEvents.length === 0 && numProcCals === 0) {
        console.log(`${ts} - ERROR - No Calendar Events Retrieved.`);
    } else {
        //Shallow Copy is good enough
        calevents = [];
        Object.assign(calevents,procCalEvents);
        calData.numCals = numProcCals;
        calData.lastSuccessfulRetrieveTime = new Date(Date.now());
        calData.calNames = getCalNames(calevents);
        calData.numEvents = calevents.length;
        console.log(`${ts} - INFO - Calendar re-loaded. ${calData.numEvents} events available`);
    }
}

//
// ------------------------------------------------------------------------------------------
//
function extractEventsFromCal(data,calName) {
    //Basic comprehension check:
    var matchingEvents = [];
    var numEntries = 0;
    var numMatches = 0;
    for (var k in data) {
        if (data.hasOwnProperty(k)) {
            var ev = data[k]
            numEntries += 1;
            if(ev.type === 'VEVENT'
               && ev.hasOwnProperty('start')) {
               numMatches += 1;
               var evDets = {    cal   : calName,
                                 //id    : ev.uid,
                                 title : ev.summary,
                              location : ev.location,
                              start : ev.start };
                //Determine duration (in minutes) - AFTER CHECKING THERE IS AN END TIME!
                if(ev.hasOwnProperty('start') && ev.hasOwnProperty('end')) {
                    var duration = ev.end.getTime() - ev.start.getTime();
                    //evDets.duration = duration / 1000;
                    evDets.end = ev.end;
                } else {
                    //evDets.duration = 0;
                    evDets.end = ev.start
                }
               
                //MCE 2017-12-28 - Handle EXDATE exclusions if they exist. Object ev.exdate may be a
                //                 singleton (single-instance with a "params" and "val") or an array of
                //                 params/val objects. Or may not exist at all.
                // MAJOR IRRITATION: EXDATE values don't conform to ISO8601 so we can't rely on Date.parse to
                //                   process them. See "convertExdateToMsec() below"
                var evExclusions = [];
                if(ev.hasOwnProperty('exdate')) {
                    //match a singleton:
                    if(ev.exdate.hasOwnProperty('val')) {
                        evExclusions.push(convertExdateToMsec(ev.exdate));
                    } else {
                        Object.keys(ev.exdate).forEach(key => {
                            //Match if we've extracted one-of-many:
                            if(ev.exdate[key].hasOwnProperty('val')) {
                                evExclusions.push(convertExdateToMsec(ev.exdate[key]));
                            }
                        });
                    }
                }
                //Check for Recurrence Rules. If there is one, add ALL entries within
                //the configured time window INSTEAD of the source event
                if(ev.hasOwnProperty('rrule')) {
                    var validRecurrences = ev.rrule.between(calData.oldestEventAge, calData.newestEventAge);
                    for(var occPtr in validRecurrences) {
                        var repStart = Date.parse(validRecurrences[occPtr]); //turn string into mSec
                        //MCE 2017-12-28: Check for value matching an EXCLUSION extracted above
                        if(evExclusions.indexOf(repStart) != -1) {
                            console.log("Skipping recurrence " + validRecurrences[occPtr] + " - Matches EXDATE Exclusion");
                            continue;
                        }
                        //Simple assignment does a reference, not a copy. This does a shallow copy which is sufficient:
                        var repEvDets = Object.assign({},evDets);
                        repEvDets.sequencenumber = occPtr;
                        repEvDets.orgStart = ev.start;
                        repEvDets.start = new Date(repStart); //turn mSec into Date() object
                        if(evDets.hasOwnProperty('duration')) {
                            repEvDets.end   = new Date(repStart + (evDets.duration * 1000)); //Cal end as start+duration msec
                        } else {
                            repEvDets.end = repEvDets.start;
                        }
                        repEvDets.recrule = ev.rrule.toText();
                        matchingEvents.push(repEvDets);
                    }
                } else {
                    //No repeat rule defined, it's a one-off. So we need to check whether it's within our window
                    //before saving it for later:
                    if(ev.start.getTime() >= calData.oldestEventAge && ev.end.getTime() <= calData.newestEventAge) {
                        matchingEvents.push(evDets);
                    }
                }
            }
        }
    }
    return matchingEvents
}
//
// ------------------------------------------------------------------------------------------
//
function convertExdateToMsec(exdate) {
    var tz = 'Europe/London';
    if(exdate.hasOwnProperty('params') && exdate.params.hasOwnProperty('TZID')) {
        tz = exdate.params.TZID;
    }
    var ts = exdate.val;
    //ts matches spec:
    //0123456789ABCDE
    //YYYYMMDDTHHMMSS
    //20171226T183000
    //String-slice to extract date, time
    var yr = ts.substring(0,4);
    var mo = ts.substring(4,6); mo = mo -1; //Constructor below treats Jan as 00 not 01
    var dy = ts.substring(6,8);
    var hr = ts.substring(9,11);
    var mn = ts.substring(11,13);
    var sc = ts.substring(13,15);

    var retTS;
    if(tz === 'Europe/London') {
        retTS = new Date(yr,mo,dy,hr,mn,sc);
    } else {
        console.log('UNKNOWN TIMEZONE "' + tz + '" - TREATING AS UTC');
        retTS = new Date(Date.UTC(yr,mo,dy,hr,mn,sc));
    }

    return(retTS.getTime());
}
