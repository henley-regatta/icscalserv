# Docker configuration file to setup and run the Calendarserver node script
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
