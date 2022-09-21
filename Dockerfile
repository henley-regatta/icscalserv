# Docker configuration file to setup and run the Calendarserver node script
# Modified from https://nodejs.org/en/docs/guides/nodejs-docker-webapp/
# BUILD with:
#       docker build . -t username/icscalserv-app 
#  (but don't forget to copy/create "configdata.json" first!)
# EXECUTE with:
#       docker run -p 24611:24611 -d --name icscalserv username/icscalserv-app
#
# 2022-09-21 - Mod image base and env vars to set TIMEZONE accordingly
FROM node:16-buster
# CODE directory in the container
WORKDIR /opt/src/icscalserv
# Setup timezone
ENV TZ="Europe/London"
# Install the app dependencies
COPY package*.json ./  
RUN npm install
# Bundle the app source 
COPY . .  
# Expose the default port 
EXPOSE 24611
# And kick off the server on start: 
CMD ["node", "calendarserver.js"]
