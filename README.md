# ICSCalServ

Ported from, and simplified version of, the calendar retrieval and parsing code I wrote for
the community centre heating project.

Stripped of all the additional requirements that project had, this one has 2 goals:

  * Periodically retrieve a set of calendar ICS files from URL locations
    (nominally Google Calendar private URLS but any ICS-compliant source will do)
  * Serve "Recent" event data from the combined calendars as a simple JSON format

Between the first and second steps is the parsing code that comprehends all the various
ICS event formats, and combines multiple calendars into a single database. 

The point of this is to provide a "lightweight" recent-event JSON source suitable for easy
consumption by a local endpoint, potentially one with limited memory/storage resources.

## Source Data 

Not included in this distribution is the configuration file required for any of the scripts
to work properly. Mostly because it's full of my own data.

However, a suitable minimal demo is possible using the file `configdata.json` placed in 
the project directory with contents:

```json
{
    "MinFileAgeBeforeRefreshHrs"    :   4,
    "ServerListenPort"              :   24611,
    "MaxEventLookBackDays"          :   1,
    "MaxEventLookAheadDays"         :   7,
    "DataDirectory"                 :   "/path/to/localcopyof/icscalserv",
    "CombinedCalendarFileName"      :   "allcalendars.ics",
    "calendarJSONFile"              :   "calendars.json",
    "calendars": [
        {   "Index" : 1,
            "Name"  : "UK Public Holidays",
            "URL"   : "https://calendar.google.com/calendar/ical/en.uk%23holiday%40group.v.calendar.google.com/public/basic.ics"
        }
    ]
}
```