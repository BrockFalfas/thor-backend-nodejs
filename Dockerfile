FROM node:8.15

WORKDIR /usr/src/app
COPY . ./
RUN yarn install
RUN yarn run build
RUN yarn run swagger

EXPOSE 8081