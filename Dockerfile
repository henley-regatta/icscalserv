# Docker configuration file to setup and run the Calendarserver node script
# Modified from https://nodejs.org/en/docs/guides/nodejs-docker-webapp/
# BUILD with:
#       docker build . -t username/icscalserv-app 
#  (but don't forget to copy/create "configdata.json" first!)
# EXECUTE with:
#       docker run -p 24611:24611 -d username/icscalserv-app

FROM node:16
# CODE directory in the container
WORKDIR /opt/src/icscalserv
# Install the app dependencies
COPY package*.json ./  
RUN npm install
# Bundle the app source 
COPY . .  
# Expose the default port 
EXPOSE 24611
# And kick off the server on start: 
CMD ["node", "calendarserver.js"]
