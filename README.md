Setup

```bash
 docker build -t npm-proxy-verdaccio ./
 docker run --rm -p 4873:4873 --name npm-proxy npm-proxy-verdaccio
 ```

 Then run

 ```bash
npm set registry http://localhost:4873/
 ```