FROM node:24-alpine

RUN npm i -g @deepseek-ai/dsh pnpm \
    && dsh plugin --profile web add dshmarket < /dev/null \
    && dsh plugin --profile web add dsh-web-startup-auth < /dev/null \
    && npm cache clean -f

VOLUME ["/root/.dsh"]

EXPOSE 3080

ENTRYPOINT ["dsh"]
CMD ["web", "--no-open", "--host", "0.0.0.0"]
