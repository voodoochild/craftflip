// Ideas and shit

function Component (options) {
  this.item_id = options.item_id;
}

// Find a recipe for a given item_id
Component.prototype.isCrafted = function () {
  var deferred = q.defer();
  if (this.hasOwnProperty('_crafted')) {
    deferred.resolve(this._crafted);
  } else {
    client.search({
      index: 'gw2',
      type: 'recipe',
      size: 50,
      body: {
        query: {
          match: {
            output_item_id: this.item_id
          }
        }
      }
    }).then((function (results) {
      this._crafted = !!results.hits.total;
      deferred.resolve(this._crafted);
    }).bind(this));
  }
  return deferred.promise;
};

var c = new Component({item_id: 11541});


// Get all recipes
client.search({
  index: 'gw2',
  type: 'recipe',
  size: 50,
  body: {
    query: {
      match_all: {
        // output_item_id: this.item_id
      }
    }
  }
}).then(function (results) {
  console.log(results.hits.total);
});


// Get a single document
client.get({
  index: 'gw2',
  type: 'recipe',
  id: 7131
}).then(function (recipe) {
  console.log(recipe._source);
});


// Find all item_ids related to every recipe we know about
client.search({
  index: 'gw2',
  type: 'recipe'
}).then(function (results) {
  var item_ids = _.map(results.hits.hits, function (recipe) {
    recipe = recipe._source;
    var ids = [recipe.output_item_id];
    if (recipe.ingredients.length) {
      ids.push(_.map(recipe.ingredients, function (ingredient) {
        return ingredient.item_id;
      }));
    }
    return ids;
  });
  console.log(_.uniq(_.flatten(item_ids)));
});

getRecipeForItem = function (item_id) {
  var deferred = q.defer();
  client.search({
    index: 'gw2',
    type: 'recipe',
    size: 1,
    body: {
      query: {
        match: {
          output_item_id: item_id
        }
      }
    }
  }).then(function (results) {
    if (results.hits.total) {
      deferred.resolve(results.hits.hits[0]._source);
    } else {
      deferred.resolve(false);
    }
  });
  return deferred.promise;
};


buildComponents = function () {
  _.forEach(recipes, function (recipe) {
    makeComponent(recipe.output_item_id, recipe.ingredients);
    if (recipe.ingredients.length) {
      _.forEach(recipe.ingredients, function (ingredient) {
        makeComponent(ingredient.item_id);
      });
    }
  });
};

makeComponent = function (item_id, ingredients) {
  components[item_id] = new Component({
    item_id: item_id,
    ingredients: ingredients,
    price: prices[item_id]
  });
};



getPrices()
  .then(getRecipes)
  .then(function () {
    getRecipeForItem(10682)
      .then(traverseRecipe)
      .then(function (recipe) {
        var recipePrices = prices[recipe.output_item_id];
        if (recipePrices.craft) {
          var spread = recipePrices.sell - (recipePrices.craft * 1.15);
          console.log('['+ recipe.output_item_id +'] '+ rounded(spread/100) +'s');
        }
      });
  });
