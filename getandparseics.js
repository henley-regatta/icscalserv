// getandparseics.js
// -----------------
// (Converted from the Pi Heating Suite's getcalics.js)
//
// Retrieve a (set of) calendar ICS files from specified URLs, and convert
// them to the internal JSON format used by "calendarserver.js"
//
// Call as "node getandparseics.js" to execute
// --------------------------------------------------------------------------
console.log(new Date(Date.now()) + " - getandparseics.js called");
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

// Import the support modules.
//  iCal format comprehender:
// (nb: use the "node" version because it's got the fromURL handler.)
var ical = require('node-ical');
//  Calendar Repetition Rule comprehender:
var rrule = require('rrule');
//  Filesystem stuff
var fs = require('fs');
//  HTTPS support (Google requires this)
var https = require('https');
// ASync Coordination Module
var async = require('async');

//Define the globvars we need from the loaded configuration
var oldestEventAge = new Date(Date.now() - (cfgdata.MaxEventLookBackDays * 86400 * 1000));
var newestEventAge = new Date(Date.now() + (cfgdata.MaxEventLookAheadDays * 86400 * 1000));

//This is the data structure we're building - a list of events from all retrieved calendars
var combinedCalendarData = [];

// MCE 2021-01-20 - COVID19 means lots of events being postponed/cancelled but the stub still
//                  existing. Code below meant if all events were cancelled, it was interpreted
//                  as "There is a problem reading data" and the local file wasn't written.
//                  ...and so the Community Centre has been running "ghost events" for weeks now...
//                 TO FIX THIS: We'll just put a marker var here which says how many calendars
//                              we've actually read, and if that's non-zero we'll write the file
//                              out anyway. Even if it's empty.
var countOfCalendarsRetrieved = 0;

async.forEach(cfgdata.calendars,
           //Per-item processing block (called asynchronously for each element in the workling list
           function(item, callback) {
                console.log("Processing Calendar: " + item.Name);
                icalGrabberWrapper(item, function(item, eventData) {
                    console.log("Extracting Events from calendar " + item.Name);
                    pushCalEventsToGlobVar(extractEventsFromCal(eventData, item.Index));
                    callback(); //must be called AFTER the work has completed on the item, hence in this callback
                });
           },
           //Final callback, called after all async per-item tasks indicate complete via their callback
           function(err) {
                console.log("Retrieve Tasks Complete");
                console.log("Total number of events in combinedCalendar: " + combinedCalendarData.length);
                if(err) {
                    console.log("Error processing calendars, exiting");
                } else {
                    processCompletedEventData();
                    console.log(new Date(Date.now()) + " - getandparseics.js complete");
                }
            }

);


//
// NORMAL SCRIPT EXIT POINT
//

//
// ------------------------------------------------------------------------------------------
// I'm beginning to hate having to work-around Node's asynchronicity
function processCompletedEventData() {

    var outputJSONFile = cfgdata.CombinedCalendarJSONFile;
    var backupJSONFile = outputJSONFile + ".previous";

    //SANITY CHECK - do NOT do file IO if we've got no new event data to process...
    if(combinedCalendarData.length === 0 && countOfCalendarsRetrieved === 0) {
        console.log("ERROR - No Calendar Events Retrieved. Skipping file-write");
    } else {
        //Thank GOD for synchronous file I/O as an option...
        console.log("INFO - " + countOfCalendarsRetrieved + " calendars were retrieved. A total of "
                    + combinedCalendarData.length + " events will be written to the local file.")
        if(fs.existsSync(backupJSONFile)) { fs.unlinkSync(backupJSONFile); }
        if(fs.existsSync(outputJSONFile)) { fs.renameSync(outputJSONFile,backupJSONFile); }

        fs.writeFileSync(outputJSONFile,JSON.stringify(combinedCalendarData),{});
        console.log("Wrote " + combinedCalendarData.length + " events to JSON file " + outputJSONFile);
    }

}

//
// ------------------------------------------------------------------------------------------
// Don't really understand why, but doing this as a function makes the sync. code seem to work
function pushCalEventsToGlobVar(someEvents) {
    console.log("Adding " + someEvents.length + " Events to combinedData");
    for ( var ev in someEvents ) {
        if(someEvents.hasOwnProperty(ev)) {
            combinedCalendarData.push(someEvents[ev]);
        }
    }
}

//
// ------------------------------------------------------------------------------------------
// It's Node: if you want to customise a callback, wrap it all up a bit...
function icalGrabberWrapper(item, callBack) {
    ical.fromURL(item.URL, {}, function(err, data) {
        if( err ) {
            console.log("Error retrieving calendar " + item.Name + ":" + err);
            callBack(item,"");
        } else {
            countOfCalendarsRetrieved += 1;
            callBack(item,data);
        }
    });
}
//
// ------------------------------------------------------------------------------------------
//
function extractEventsFromCal(data,reqZoneIndex) {
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
               var evDets = {       id : ev.uid,
                                 title : ev.summary,
                              location : ev.location,
                              start : ev.start };
                //Determine duration (in minutes) - AFTER CHECKING THERE IS AN END TIME!
                if(ev.hasOwnProperty('start') && ev.hasOwnProperty('end')) {
                    var duration = ev.end.getTime() - ev.start.getTime();
                    evDets.duration = duration / 1000;
                    evDets.end = ev.end;
                } else {
                    evDets.duration = 0;
                }
                //Check that the location STARTS with the Index number, append if not
                //(check+balance for later relay processing
                if(!(ev.location.substring(0,1) == reqZoneIndex)) {
                    console.log("Appending |" + reqZoneIndex + "|")
                    evDets.location = reqZoneIndex + " "  + ev.location;
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
                    var validRecurrences = ev.rrule.between(oldestEventAge, newestEventAge);
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
                        repEvDets.end   = new Date(repStart + (evDets.duration * 1000)); //Cal end as start+duration msec
                        repEvDets.recrule = ev.rrule.toText();
                        matchingEvents.push(repEvDets);
                    }
                } else {
                    //No repeat rule defined, it's a one-off. So we need to check whether it's within our window
                    //before saving it for later:
                    if(ev.start.getTime() >= oldestEventAge && ev.end.getTime() <= newestEventAge) {
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
