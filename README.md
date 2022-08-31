# ICSCalServ

Ported from, and simplified version of, the calendar retrieval and parsing code I wrote for
the community centre heating project.

Stripped of all the additional requirements that project had, this one has 2 goals:

  * Periodically retrieve a set of calendar ICS files from URL locations
    (nominally Google Calendar private URLS but any ICS-compliant source will do)
  * Serve "Recent" event data from the combined calendars as a simple JSON format

Between the first and second steps is the parsing code that comprehends
all the various ICS event formats, and combines multiple calendars into a
single database. The point of this is to provide a "lightweight"
recent-event JSON source suitable for easy consumption by a local
endpoint, potentially one with limited memory/storage resources.

Eventually this will be provided by a single node-hosted server process
but for development purposes it's split into a "retriever"
(`getandparseics.js`) and a "server" (`calendarserver.js`):

  * `getandparseics.js` is responsible for retrieving the calendars, parsing
them (interpreting repeating events, exclusions etc), filtering them into
the timewindow of interest, and storing the result as a (compact) JSON
data structure

  * `calendarserver.js` is (currently) responsible for serving out the
  events as JSON responses to a simple query format; just about the only
  specification it'll take as input at the minute is a simple days-before
  and days-after "now". Data served is taken from the output of the
  retriever and only augmented with the sub-period, data age and
  request-time data. This is to allow a querying device to know both what
  the current epoch is and how current the data retrieved is. Handy if the
  device has no RTC and limited memory....

## Source Data 

Not included in this distribution is the configuration file required for
any of the scripts to work properly. Mostly because it's full of my own
data.

However, a suitable minimal demo is possible using the file
`configdata.json` placed in the project directory with contents:

```json
{
    "MinFileAgeBeforeRefreshHrs"    :   4,
    "ServerListenPort"              :   24611,
    "MaxEventLookBackDays"          :   14,
    "MaxEventLookAheadDays"         :   90,
    "DataDirectory"                 :   "/path/to/localcopyof/icscalserv",
    "calendarJSONFile"              :   "calendars.json",
    "calendars": [
        {   "Name"  : "UK Public Holidays",
            "URL"   : "https://calendar.google.com/calendar/ical/en.uk%23holiday%40group.v.calendar.google.com/public/basic.ics"
        },
        {   "Name"  : "Jewish Holidays",
            "URL"   : "http://www.calendarlabs.com/ical-calendar/ics/55/Jewish_Holidays.ics"
        },
        {   "Name"  : "International Holidays",
            "URL"   : "http://www.calendarlabs.com/ical-calendar/ics/56/International_Holidays.ics"
        }
    ]
}
```
