# Built by OpenShift (Docker strategy). Public Red Hat UBI image: no registry login needed.
FROM registry.access.redhat.com/ubi9/nodejs-22-minimal

WORKDIR /opt/app-root/src
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.js ./

ENV PORT=8080 NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
