# ICSCalServ

Ported from, and simplified version of, the calendar retrieval and parsing code I wrote for
the community centre heating project.

For an example of a consumer of the data this produces, see also [henley-regatta/pico_calendar_display](https://github.com/henley-regatta/pico_calendar_display)

Stripped of all the additional requirements that project had, this one has 2 goals:

  * Periodically retrieve a set of calendar ICS files from URL locations
    (nominally Google Calendar private URLS but any ICS-compliant source will do)
  * Serve "Recent" event data from the combined calendars as a simple JSON format

Between the first and second steps is the parsing code that comprehends
all the various ICS event formats, and combines multiple calendars into a
single database. The point of this is to provide a "lightweight"
recent-event JSON source suitable for easy consumption by a local
endpoint, potentially one with limited memory/storage resources.

This version now has an "integrated" server in `calendarserver.js` that is 
capable of retrieving the calendars from the URLS, parsing them itself,
and serving them.

For legacy reasons there's also a standalone calendar retriever in
`getandparseics.js` which will *only* retrieve the configured calendars
and parse them into a local JSON file; this was originally the input to
the server program for the previous implementation and may be useful to
someone else but has outlived it's utility in the current implementation.

The server is (sort-of) self documenting in as much as it issues an error
message if an unknown URI is requested. However it doesn't self-document the
supported time ranges available for request, which are:

  * `http://server/json?today`    - Return only events occuring today (that's "within the current 24-hr period")
  * `http://server/json?tomorrow` - Return only events occuring tomorrow (that's "from midnight tonight for a 24-hr period")
  * `http://server/json?week`     - Return only events occuring within the next 7 days
  * `http://server/json?fullrange` - Return all events found in the data spec (which is, itself, clamped to a restricted time period, see config file below)

Any other time specification, including __no__ query parameter, is interpreted as a default which is all events occurring TODAY or TOMORROW. 

## Source Data 

Not included in this distribution is the configuration file required for
any of the scripts to work properly. Mostly because it's full of my own
data.

However, a suitable minimal demo is possible using the file
`configdata.json` placed in the project directory with contents:

```json
{
    "MinDataAgeBeforeRefreshHrs"    :   4,
    "ServerListenPort"              :   24611,
    "MaxEventLookBackDays"          :   14,
    "MaxEventLookAheadDays"         :   90,
    "DataDirectory"                 :   "/path/to/localcopyof/icscalserv",
    "calendarJSONFile"              :   "calendars.json",
    "compactOutput"                 :   false,
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
## Docker/Container Build

An example `Dockerfile` (and `.dockerignore`) is included to allow
containerisation of a build; no warranty is provided for either of these
and in particular some of the config values are "baked in" to the
container build process which is a bit unfortunate at the minute and could
do with improvement. A short guide to doing this yourself would be:

  * Install Docker
  * `git clone https://github.com/henley-regatta/icscalserv.git`
  * Create a `configdata.json` file in the source directory `./icscalserv` (*i.e.* create `./icscalserv/configdata.json`)
    * Make sure to update the calendar URLs you want to use
    * `DataDirectory` is not used by the server and can be omitted; although the value for `calendarJSONFile` isn't used, a value **must** be defined for it
    * Make a note of the value you set for `ServerListenPort` - if changed from the default update the `Dockerfile` EXPOSE value and change (at least) the source port on the RUN command
  * Build the container from the `icscalserv` directory using: `docker build -t myUserName/icscalserv-app`
  * Assuming it built (it should!), run the container using: `docker run -p 24611:24611 -d --name icscalserv myUserName/icscalserv-app`
    * Remember to adjust the `-p 24611:24611` values if you changed `ServerListenPort`
  * The server should then be available both locally ("localhost") and via the hostname at `http://hostname:24611/json`
